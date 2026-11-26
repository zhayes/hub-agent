import type { BrainBudget, OrchestratorBrain } from '../../brain/types'
import type { Goal, Subtask, Task, VerificationCheck } from '../../domain/entities'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../domain/ids'
import type { SandboxNetworkMode, SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'
import { runAcpWithRetry } from '../acp-retry'
import type { RunAcpTaskResult } from '../acp-run'
import type { AgentRecord } from '../agent-registry'
import { runBrainRound } from '../brain-loop'
import { createAcpDispatchExecutor } from '../dispatch/acp-executor'
import { enqueueDispatch } from '../dispatch/queue'
import { drainDispatches } from '../dispatch/runner'
import { deriveIdempotencyKey } from '../recovery/idempotency'
import { completeTaskAfterDelivery } from './finalize'
import { mergeNoFf } from './git'
import { abortWorktreeSession, createWorktreeSession, type WorktreeSession } from './session'

export interface RunParallelAgentsOptions {
  db: Db
  provider: SandboxProvider
  agents: readonly AgentRecord[]
  objective: string
  repoRoot: string
  checks: readonly VerificationCheck[]
  clientVersion: string
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  allowedWrite?: readonly string[]
  transcriptDir?: string
  brain?: OrchestratorBrain
  budget?: BrainBudget
}

export interface ParallelSubtaskResult {
  agent: { id: string; name: string }
  subtaskId: string
  executionId: string
  worktree: string
  branch: string
  verdict: RunAcpTaskResult['verdict']
  ok: boolean
}

export interface RunParallelAgentsResult {
  ok: boolean
  goalId: string
  taskId: string
  subtasks: ParallelSubtaskResult[]
  merges: Array<{ branch: string; ok: boolean }>
  decisions?: number
}

/** “分析依赖风险，同时检查核心代码质量” → 两个子任务目标。 */
export function splitParallelObjective(objective: string, count: number): string[] {
  const parts = objective
    .split(/[，,]\s*同时|同时/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === count) return parts
  if (parts.length > 0) {
    const result = parts.slice(0, count)
    while (result.length < count) result.push(objective)
    return result
  }
  return Array.from({ length: count }, () => objective)
}

/**
 * M7 的双 Agent 并行：一个 Goal/Task，两个 Subtask，各自独立 worktree/lease。
 * 两个都验收通过后按顺序 merge --no-ff；不同文件成功，同文件冲突抛 DELIVERY_CONFLICT。
 */
export async function runParallelAgents(
  options: RunParallelAgentsOptions,
): Promise<RunParallelAgentsResult> {
  if (options.agents.length < 2) {
    throw new Error('并行执行至少需要两个 Agent')
  }
  const goalId = asGoalId(newId())
  const taskId = asTaskId(newId())
  const at = asTimestamp(new Date().toISOString())
  const title =
    options.objective.length > 80 ? `${options.objective.slice(0, 77)}...` : options.objective

  const goal: Goal = {
    id: goalId,
    userId: 'local',
    title,
    intent: options.objective,
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const task: Task = {
    id: taskId,
    goalId,
    title,
    description: options.objective,
    status: 'draft',
    priority: 0,
    acceptanceCriteria: ['每个子任务验收通过并完成合并'],
    createdAt: at,
    updatedAt: at,
  }
  let state = loadState(options.db)
  state = appendEvent(options.db, state, { type: 'goal.created', goal }).state
  state = appendEvent(options.db, state, { type: 'task.created', task }).state

  let objectives = splitParallelObjective(options.objective, options.agents.length)
  let decisions: number | undefined
  if (options.brain !== undefined) {
    const round = await runBrainRound({
      db: options.db,
      brain: options.brain,
      goalId,
      reason: 'plan_invalid',
      dedupeKey: `goal:${goalId}:parallel-plan`,
      agents: options.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        ...(agent.capabilities === undefined ? {} : { capabilities: agent.capabilities }),
      })),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    })
    decisions = round === undefined ? 0 : 1
    const drafts =
      round?.actions
        .filter((action) => action.type === 'revise_plan')
        .flatMap((action) => action.subtasks) ?? []
    if (drafts.length > 0) {
      objectives = drafts.slice(0, options.agents.length).map((draft) => draft.description)
      while (objectives.length < options.agents.length) objectives.push(options.objective)
    }
  }

  const subtasks = options.agents.map((agent, index): Subtask => {
    const subtask: Subtask = {
      id: asSubtaskId(newId()),
      taskId,
      title: objectives[index] ?? options.objective,
      description: objectives[index] ?? options.objective,
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: [],
      assignedAgentId: asAgentId(agent.id),
      priority: 0,
      maxAttempts: 1,
      createdAt: at,
      updatedAt: at,
    }
    state = appendEvent(options.db, state, { type: 'subtask.created', subtask }).state
    return subtask
  })

  // 并行编排预先启动 Task；各 Subtask 仍由 runAcpTask 独立 assigned/running。
  for (const to of ['planning', 'ready', 'running'] as const) {
    state = appendEvent(options.db, state, {
      type: 'task.status',
      taskId,
      to,
      at: asTimestamp(new Date().toISOString()),
    }).state
  }

  const sessions: Array<{ session: WorktreeSession; agent: AgentRecord; subtask: Subtask }> = []
  try {
    for (const [index, agent] of options.agents.entries()) {
      const subtask = subtasks[index]
      if (subtask === undefined) continue
      const session = await createWorktreeSession({
        db: options.db,
        provider: options.provider,
        repoRoot: options.repoRoot,
        agentId: agent.id,
        ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
        ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
      })
      sessions.push({ session, agent, subtask })
    }

    const results = await Promise.all(
      sessions.map(async ({ session, agent, subtask }) => {
        const idempotencyKey = deriveIdempotencyKey({
          goalId,
          subtaskId: subtask.id,
          attempt: 1,
        })
        /* 与单条路径一致：意图先落库，再交给 Dispatcher 执行（ADR 0027 D4）。
           worktree 租约已经固定了 executionId，所以显式传给意图。 */
        const { intent } = enqueueDispatch(options.db, {
          goalId,
          taskId,
          subtaskId: subtask.id,
          target: 'local-acp',
          agentId: String(agent.id),
          objective: subtask.description,
          idempotencyKey,
          executionId: session.executionId,
          payload: {
            worktree: session.worktreePath,
            ...(options.checks === undefined ? {} : { checks: options.checks }),
            ...(options.transcriptDir === undefined
              ? {}
              : { transcriptDir: options.transcriptDir }),
            ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
            ...(options.allowedDomains === undefined
              ? {}
              : { allowedDomains: options.allowedDomains }),
            ...(options.clientVersion === undefined
              ? {}
              : { clientVersion: options.clientVersion }),
            allowedWrite: [...(options.allowedWrite ?? []), ...session.gitWritePaths],
          },
        })

        let result: RunAcpTaskResult | undefined
        await drainDispatches(options.db, {
          goalId,
          intentId: intent.id,
          max: 1,
          executor: createAcpDispatchExecutor({
            db: options.db,
            runTask: async (_item, executionId) => {
              result = await runAcpWithRetry({
                db: options.db,
                provider: options.provider,
                agent,
                availableAgents: options.agents,
                objective: subtask.description,
                worktree: session.worktreePath,
                goalId,
                taskId,
                subtaskId: subtask.id,
                executionId,
                clientVersion: options.clientVersion,
                checks: options.checks,
                ...(options.transcriptDir === undefined
                  ? {}
                  : { transcriptDir: options.transcriptDir }),
                ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
                ...(options.allowedDomains === undefined
                  ? {}
                  : { allowedDomains: options.allowedDomains }),
                allowedWrite: [...(options.allowedWrite ?? []), ...session.gitWritePaths],
              })
              return result
            },
            decisionFor: () => ({
              reason: 'subtask_terminal',
              dedupeKey: `subtask:${subtask.id}:terminal`,
            }),
          }),
        })
        if (result === undefined) {
          throw new HubError('ACTION_REJECTED', '该子任务已有执行，本轮不重复派发', {
            goalId,
            subtaskId: subtask.id,
            idempotencyKey,
          })
        }
        return { result, session, agent, subtask }
      }),
    )

    const allPass = results.every((item) => item.result.ok)
    const merges: Array<{ branch: string; ok: boolean }> = []
    if (allPass) {
      for (const item of results) {
        await mergeNoFf(item.session.gitRunner, options.repoRoot, item.session.branch)
        merges.push({ branch: item.session.branch, ok: true })
      }
      completeTaskAfterDelivery(options.db, taskId, goalId)
    }

    return {
      ok: allPass,
      goalId,
      taskId,
      subtasks: results.map((item) => ({
        agent: { id: item.agent.id, name: item.agent.name },
        subtaskId: item.subtask.id,
        executionId: item.result.executionId,
        worktree: item.session.worktreePath,
        branch: item.session.branch,
        verdict: item.result.verdict,
        ok: item.result.ok,
      })),
      merges,
      ...(decisions === undefined ? {} : { decisions }),
    }
  } finally {
    for (const item of sessions) {
      await abortWorktreeSession(options.db, item.session).catch(() => undefined)
    }
  }
}
