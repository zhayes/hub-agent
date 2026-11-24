import { createBrainFromEnv } from '../brain/create-brain'
import type { BrainBudget, DecisionRecord, OrchestratorBrain } from '../brain/types'
import type { Goal, Subtask, Task } from '../domain/entities'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { runAcpWithRetry } from './acp-retry'
import type { RunAcpTaskOptions, RunAcpTaskResult } from './acp-run'
import { runBrainRound } from './brain-loop'

/**
 * M6 的 Brain 驱动入口：
 *   建 Goal → Brain 拆计划 → Brain 选 Agent → 执行 → Brain 接收结果。
 *
 * 默认走 Pi SDK Brain（HUBAGENT_BRAIN_MODE=pi）；显式 scripted 才用测试替身。
 * LLM 输出仍由 brain-loop/validate 做 schema/权限/预算/幂等校验。
 */

export interface RunGoalWithBrainOptions
  extends Omit<RunAcpTaskOptions, 'goalId' | 'plan' | 'taskId' | 'subtaskId'> {
  brain?: OrchestratorBrain
  budget?: BrainBudget
}

export interface RunGoalWithBrainResult extends RunAcpTaskResult {
  executions: RunAcpTaskResult[]
  decisions: DecisionRecord[]
}

export async function runGoalWithBrain(
  options: RunGoalWithBrainOptions,
): Promise<RunGoalWithBrainResult> {
  const { brain = createBrainFromEnv(), budget, ...taskOptions } = options
  const goalId = asGoalId(newId())
  const now = asTimestamp(new Date().toISOString())
  const title =
    options.objective.length > 80 ? `${options.objective.slice(0, 77)}...` : options.objective
  const goal: Goal = {
    id: goalId,
    userId: 'local',
    title,
    intent: options.objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  let state = loadState(options.db)
  state = appendEvent(options.db, state, { type: 'goal.created', goal }).state

  const agents = [
    {
      id: options.agent.id,
      name: options.agent.name,
      status: options.agent.status,
      ...(options.agent.capabilities === undefined
        ? {}
        : { capabilities: options.agent.capabilities }),
    },
  ]

  const decompose = await runBrainRound({
    db: options.db,
    brain,
    goalId,
    reason: 'plan_invalid',
    dedupeKey: `goal:${goalId}:decompose`,
    agents,
    ...(budget === undefined ? {} : { budget }),
  })
  if (decompose === undefined) {
    throw new HubError('ACTION_REJECTED', '初始计划决策点已被处理', { goalId })
  }
  const drafts = decompose.actions
    .filter((action) => action.type === 'revise_plan')
    .flatMap((action) => action.subtasks)
  if (drafts.length === 0) {
    throw new HubError('ACTION_REJECTED', 'Brain 未产出 revise_plan', {
      goalId,
      actions: decompose.actions,
    })
  }

  const taskId = asTaskId(newId())
  state = loadState(options.db)
  state = appendEvent(options.db, state, {
    type: 'task.created',
    task: {
      id: taskId,
      goalId,
      title: drafts[0]?.title ?? title,
      description: options.objective,
      status: 'draft',
      priority: 0,
      acceptanceCriteria: ['每个子任务执行完成并产出可核验的 diff'],
      createdAt: now,
      updatedAt: now,
    } satisfies Task,
  }).state
  for (const to of ['planning', 'ready', 'running'] as const) {
    state = appendEvent(options.db, state, {
      type: 'task.status',
      taskId,
      to,
      at: asTimestamp(new Date().toISOString()),
    }).state
  }
  const draftSubtasks = drafts.map((draft) => {
    const subtask: Subtask = {
      id: asSubtaskId(newId()),
      taskId,
      title: draft.title,
      description: draft.description,
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: draft.requiredCapabilities,
      assignedAgentId: asAgentId(options.agent.id),
      priority: 0,
      maxAttempts: draft.maxAttempts ?? 1,
      createdAt: now,
      updatedAt: now,
    }
    state = appendEvent(options.db, state, { type: 'subtask.created', subtask }).state
    return subtask
  })

  const executions: RunAcpTaskResult[] = []
  for (const [index, subtask] of draftSubtasks.entries()) {
    const draft = drafts[index]
    if (draft === undefined) continue
    const result = await runAcpWithRetry({
      ...taskOptions,
      goalId,
      taskId,
      subtaskId: subtask.id,
      objective: draft.description,
    })
    executions.push(result)
    if (!result.ok) break
  }
  const result = executions[executions.length - 1]
  if (result === undefined) {
    throw new HubError('ACTION_REJECTED', 'Brain 计划没有可执行子任务', { goalId })
  }

  const after = await runBrainRound({
    db: options.db,
    brain,
    goalId,
    reason: 'subtask_terminal',
    dedupeKey: `goal:${goalId}:after-run`,
    agents,
    ...(budget === undefined ? {} : { budget }),
  })

  return {
    ...result,
    executions,
    decisions: [decompose.record, ...(after === undefined ? [] : [after.record])],
  }
}
