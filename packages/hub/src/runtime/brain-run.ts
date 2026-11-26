import { createBrainFromEnv } from '../brain/create-brain'
import type {
  BrainAction,
  BrainBudget,
  BrainDeltaSink,
  ChatTurn,
  Clarification,
  DecisionRecord,
  OrchestratorBrain,
} from '../brain/types'
import type { Goal, Subtask, Task } from '../domain/entities'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp, type TaskId } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { runAcpWithRetry } from './acp-retry'
import type { RunAcpTaskOptions, RunAcpTaskResult } from './acp-run'
import type { AgentRecord } from './agent-registry'
import { runBrainRound } from './brain-loop'
import { createClarification } from './clarify'
import { cancelTask } from './recovery/cancel'
import { failGoal } from './recovery/fail'
import { completeGoal, completeTaskAfterDelivery } from './workspace/finalize'

/**
 * M6 的 Brain 驱动入口：
 *   建 Goal → Brain 拆计划 → Brain 选 Agent → 执行 → Brain 接收结果。
 *
 * 默认走 Pi SDK Brain（HUBAGENT_BRAIN_MODE=pi）；显式 scripted 才用测试替身。
 * LLM 输出仍由 brain-loop/validate 做 schema/权限/预算/幂等校验。
 */

export type RunProgressStage =
  | 'thinking'
  | 'planned'
  | 'dispatching'
  | 'retrying'
  | 'waiting'
  | 'completed'
  | 'failed'

/** 执行过程的一个关键点；控制台把它落成 chat message（kind=progress）。 */
export interface RunProgressStep {
  stage: RunProgressStage
  text: string
  agent?: string
}

export interface RunGoalWithBrainOptions
  extends Omit<RunAcpTaskOptions, 'goalId' | 'plan' | 'taskId' | 'subtaskId'> {
  brain?: OrchestratorBrain
  budget?: BrainBudget
  /** Chat 入口的最近若干轮对话；任务/CLI 路径不传 */
  conversation?: readonly ChatTurn[]
  /** Chat 的逐字回复：只在首个 Brain 回合转发增量。 */
  onBrainDelta?: BrainDeltaSink
  /** 可参与自动换 Agent 的候选；默认只有 options.agent */
  availableAgents?: readonly AgentRecord[]
  /** 共享工作区完成即落 Task completed；worktree 由交付/merge 后 finalize */
  completeOnSuccess?: boolean
  /** 执行过程回调；只做展示，异常不得影响执行 */
  onProgress?: (step: RunProgressStep) => void
  /** Chat/HTTP 需要尽早拿到 goal/task id；回调不得抛错影响执行 */
  onGoalCreated?: (goalId: string) => void
  onTaskCreated?: (input: { goalId: string; taskId: string }) => void
}

export interface RunGoalWithBrainResult {
  ok: boolean
  goalId: string
  /** 只回复、没建任务时为空（对话路径）。 */
  taskId?: string
  /** Brain 给用户看的最终文本：reply / finish.summary。 */
  reply?: string
  subtaskId?: string
  executionId?: string
  sessionId?: string
  agent: { id: string; name: string }
  stopReason: string
  attempt?: number
  verdict: 'pass' | 'fail' | 'manual_required' | 'not_run'
  verification?: RunAcpTaskResult['verification']
  approval?: RunAcpTaskResult['approval']
  evidence?: RunAcpTaskResult['evidence']
  transcriptRef?: string
  updates?: number
  durationMs: number
  executions: RunAcpTaskResult[]
  decisions: DecisionRecord[]
  clarification?: Clarification
}

export async function runGoalWithBrain(
  options: RunGoalWithBrainOptions,
): Promise<RunGoalWithBrainResult> {
  const {
    brain = createBrainFromEnv(),
    budget,
    completeOnSuccess = true,
    onProgress,
    onGoalCreated,
    onTaskCreated,
    ...taskOptions
  } = options
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
  onGoalCreated?.(goalId)

  const report = (step: RunProgressStep): void => {
    try {
      onProgress?.(step)
    } catch {
      // 过程展示失败不能拖垮执行。
    }
  }
  const agentLabel = options.agent.name

  const availableAgents = options.availableAgents ?? [options.agent]
  const agentPool = availableAgents.length > 0 ? availableAgents : [options.agent]
  const agentById = new Map<string, AgentRecord>(
    agentPool.map((agent) => [String(agent.id), agent]),
  )
  const pickSubtaskAgent = (
    _subtask: { requiredCapabilities: readonly string[] },
    requestedId: string | undefined,
  ): AgentRecord => {
    if (requestedId !== undefined) {
      const found = agentById.get(requestedId)
      if (found !== undefined && found.status !== 'offline' && found.status !== 'error')
        return found
    }
    /* 没点名时保持既有默认 Agent，把换 Agent 留给重试时的 Selection Engine。 */
    return options.agent
  }

  const agents = availableAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    ...(agent.capabilities === undefined ? {} : { capabilities: agent.capabilities }),
  }))

  const conversation = options.conversation
  const decompose = await runBrainRound({
    db: options.db,
    brain,
    goalId,
    reason: 'plan_invalid',
    dedupeKey: `goal:${goalId}:decompose`,
    agents,
    ...(budget === undefined ? {} : { budget }),
    ...(conversation === undefined ? {} : { conversation }),
    ...(options.onBrainDelta === undefined ? {} : { onDelta: options.onBrainDelta }),
  })
  if (decompose === undefined) {
    throw new HubError('ACTION_REJECTED', '初始计划决策点已被处理', { goalId })
  }
  const decisions = [decompose.record]
  let drafts = decompose.actions
    .filter((action) => action.type === 'revise_plan')
    .flatMap((action) => action.subtasks)
  if (drafts.length === 0) {
    /* 还没计划就先问人：把问题落成 Clarification，由控制台渲染成可点选项，
       而不是把一整轮对话判成失败。 */
    const human = decompose.actions.find((action) => action.type === 'request_human')
    if (human !== undefined) {
      report({ stage: 'waiting', text: `需要你确认：${human.question.slice(0, 120)}` })
      return waitingResult({
        goalId,
        agent: { id: options.agent.id, name: options.agent.name },
        executions: [],
        decisions,
        clarification: createClarification(options.db, {
          goalId,
          kind: human.kind === 'clarify' && human.executionId !== undefined ? 'clarify' : 'decide',
          question: human.question,
          ...(human.options === undefined ? {} : { options: human.options }),
          ...(human.executionId === undefined ? {} : { executionId: human.executionId }),
        }),
      })
    }
    /* 只回答、不动手：直接回给用户，不建 Task。 */
    const reply = replyTextOf(decompose.actions)
    if (reply !== undefined) {
      completeGoal(options.db, goalId)
      return {
        ok: true,
        goalId,
        agent: { id: options.agent.id, name: options.agent.name },
        stopReason: 'replied',
        verdict: 'not_run',
        durationMs: 0,
        executions: [],
        decisions,
        reply,
      }
    }
    throw new HubError(
      'ACTION_REJECTED',
      'Brain 没有产出可执行动作（既没有 revise_plan 也没有 reply）',
      {
        goalId,
        actions: decompose.actions,
      },
    )
  }

  if (decompose.record.rationale !== '') {
    report({ stage: 'thinking', text: decompose.record.rationale.slice(0, 240) })
  }
  report({
    stage: 'planned',
    text: `计划 ${drafts.length} 个步骤：${drafts
      .map((draft) => draft.title)
      .join(' / ')
      .slice(0, 120)}`,
  })
  let createdPlan = createTaskPlan({
    db: options.db,
    goalId,
    objective: options.objective,
    drafts,
    agentId: options.agent.id,
    at: now,
  })
  let taskId = createdPlan.taskId
  let draftSubtasks = createdPlan.subtasks
  onTaskCreated?.({ goalId, taskId })

  const executions: RunAcpTaskResult[] = []
  let lastResult: RunAcpTaskResult | undefined
  let replyText: string | undefined
  let roundIndex = 0
  let replans = 0

  while (roundIndex < 20) {
    const round = await runBrainRound({
      db: options.db,
      brain,
      goalId,
      reason: roundIndex === 0 ? 'plan_invalid' : 'subtask_terminal',
      dedupeKey: `goal:${goalId}:dispatch:${roundIndex}`,
      agents,
      ...(budget === undefined ? {} : { budget }),
      ...(conversation === undefined ? {} : { conversation }),
    })
    roundIndex += 1
    if (round === undefined) break
    decisions.push(round.record)
    if (round.record.rationale !== '' && round.record.rationale !== 'no rationale') {
      report({ stage: 'thinking', text: round.record.rationale.slice(0, 240) })
    }
    const turnReply = replyTextOf(round.actions)
    if (turnReply !== undefined) replyText = turnReply

    const human = round.actions.find((action) => action.type === 'request_human')
    if (human !== undefined) {
      report({ stage: 'waiting', text: `需要你确认：${human.question.slice(0, 120)}` })
      const clarification = createClarification(options.db, {
        goalId,
        kind: human.kind ?? (human.executionId === undefined ? 'decide' : 'clarify'),
        question: human.question,
        ...(human.options === undefined ? {} : { options: human.options }),
        ...(human.executionId === undefined ? {} : { executionId: human.executionId }),
      })
      const current = loadState(options.db)
      if (current.tasks[taskId]?.status === 'running') {
        appendEvent(options.db, current, {
          type: 'task.status',
          taskId,
          to: 'waiting_input',
          at: asTimestamp(new Date().toISOString()),
        })
      }
      return waitingResult({
        goalId,
        taskId,
        agent: { id: options.agent.id, name: options.agent.name },
        executions,
        decisions,
        clarification,
        ...(lastResult === undefined ? {} : { last: lastResult }),
      })
    }

    const cancel = round.actions.find((action) => action.type === 'cancel')
    if (cancel !== undefined) {
      cancelTask(options.db, taskId)
      return waitingResult({
        goalId,
        taskId,
        agent: { id: options.agent.id, name: options.agent.name },
        executions,
        decisions,
        stopReason: 'canceled',
        ...(lastResult === undefined ? {} : { last: lastResult }),
      })
    }

    const executed = new Set(executions.map((item) => item.subtaskId))
    const delegatedAgent = new Map<string, string>()
    for (const action of round.actions) {
      if (action.type === 'delegate' && action.request.agentId !== undefined) {
        delegatedAgent.set(action.request.subtaskId, action.request.agentId)
      }
    }
    const requested = new Set(
      round.actions
        .filter((action) => action.type === 'delegate')
        .map((action) => action.request.subtaskId),
    )
    const ready = draftSubtasks.filter(
      (subtask) => !executed.has(subtask.id) && subtask.status === 'ready',
    )
    const targets =
      requested.size === 0 ? ready : ready.filter((subtask) => requested.has(subtask.id))
    if (targets.length === 0) break

    for (const subtask of targets) {
      /* Brain 点名了 Agent 就听它的；没点名再过 Selection Engine，而不是永远吃默认值。 */
      const chosen = pickSubtaskAgent(subtask, delegatedAgent.get(subtask.id))
      report({
        stage: 'dispatching',
        text: `派给 ${chosen.name}：${subtask.title}`,
        agent: chosen.name,
      })
      let result: RunAcpTaskResult
      try {
        result = await runAcpWithRetry({
          ...taskOptions,
          agent: chosen,
          goalId,
          taskId,
          subtaskId: subtask.id,
          objective: subtask.description,
        })
      } catch (error) {
        report({
          stage: 'failed',
          text: `${chosen.name} 启动失败：${error instanceof Error ? error.message : String(error)}`,
          agent: chosen.name,
        })
        throw error
      }
      report(
        result.ok
          ? {
              stage: 'completed',
              text: `${chosen.name} 执行完成（验收 ${result.verdict}）`,
              agent: chosen.name,
            }
          : {
              stage: 'failed',
              text: `${chosen.name} 执行未通过（${result.stopReason}）`,
              agent: chosen.name,
            },
      )
      executions.push(result)
      lastResult = result
      if (!result.ok) break
    }
    if (lastResult !== undefined && !lastResult.ok) {
      if (lastResult.approval !== undefined || lastResult.stopReason === 'waiting_approval') {
        report({ stage: 'waiting', text: '等待你批准后继续', agent: agentLabel })
        return { ...lastResult, executions, decisions }
      }
      if (lastResult.replanRequired === true && replans < 2) {
        replans += 1
        report({
          stage: 'retrying',
          text: `换一种做法重试（第 ${replans} 次）`,
          agent: agentLabel,
        })
        const replan = await runBrainRound({
          db: options.db,
          brain,
          goalId,
          reason: 'plan_invalid',
          dedupeKey: `goal:${goalId}:replan:${replans}`,
          agents,
          ...(budget === undefined ? {} : { budget }),
        })
        if (replan !== undefined) decisions.push(replan.record)
        const revised =
          replan?.actions
            .filter((action) => action.type === 'revise_plan')
            .flatMap((action) => action.subtasks) ?? []
        drafts =
          revised.length > 0
            ? revised
            : drafts.map((draft) => ({
                ...draft,
                title: `${draft.title} [retry ${replans}]`,
              }))
        createdPlan = createTaskPlan({
          db: options.db,
          goalId,
          objective: options.objective,
          drafts,
          agentId: options.agent.id,
          at: asTimestamp(new Date().toISOString()),
        })
        taskId = createdPlan.taskId
        draftSubtasks = createdPlan.subtasks
        onTaskCreated?.({ goalId, taskId })
        continue
      }
      failGoal(options.db, goalId)
      break
    }
  }

  if (lastResult === undefined) {
    throw new HubError('ACTION_REJECTED', 'Brain 计划没有可执行子任务', { goalId })
  }
  if (lastResult.ok && completeOnSuccess) {
    completeTaskAfterDelivery(options.db, lastResult.taskId, lastResult.goalId)
  }
  return {
    ...lastResult,
    executions,
    decisions,
    ...(replyText === undefined ? {} : { reply: replyText }),
  }
}

/** Brain 想直接对用户说话时返回文本；finish 也算（模型常拿它当回答）。 */
function replyTextOf(actions: readonly BrainAction[]): string | undefined {
  for (const action of actions) {
    if (action.type === 'reply') return action.text
    if (action.type === 'finish') return action.summary
  }
  return undefined
}

function createTaskPlan(input: {
  db: Db
  goalId: string
  objective: string
  drafts: readonly {
    title: string
    description: string
    requiredCapabilities: string[]
    maxAttempts?: number
  }[]
  agentId: string
  at: string
}): { taskId: TaskId; subtasks: Subtask[] } {
  let state = loadState(input.db)
  const taskId = asTaskId(newId())
  state = appendEvent(input.db, state, {
    type: 'task.created',
    task: {
      id: taskId,
      goalId: asGoalId(input.goalId),
      title: input.drafts[0]?.title ?? input.objective,
      description: input.objective,
      status: 'draft',
      priority: 0,
      acceptanceCriteria: ['每个子任务执行完成并产出可核验的 diff'],
      createdAt: asTimestamp(input.at),
      updatedAt: asTimestamp(input.at),
    } satisfies Task,
  }).state
  for (const to of ['planning', 'ready', 'running'] as const) {
    state = appendEvent(input.db, state, {
      type: 'task.status',
      taskId,
      to,
      at: asTimestamp(new Date().toISOString()),
    }).state
  }
  const subtasks = input.drafts.map((draft) => {
    const subtask: Subtask = {
      id: asSubtaskId(newId()),
      taskId,
      title: draft.title,
      description: draft.description,
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: draft.requiredCapabilities,
      assignedAgentId: asAgentId(input.agentId),
      priority: 0,
      maxAttempts: draft.maxAttempts ?? 1,
      createdAt: asTimestamp(input.at),
      updatedAt: asTimestamp(input.at),
    }
    state = appendEvent(input.db, state, { type: 'subtask.created', subtask }).state
    return subtask
  })
  return { taskId, subtasks }
}

function waitingResult(input: {
  goalId: string
  taskId?: string
  agent: { id: string; name: string }
  executions: RunAcpTaskResult[]
  decisions: DecisionRecord[]
  clarification?: Clarification
  stopReason?: string
  last?: RunAcpTaskResult
}): RunGoalWithBrainResult {
  const stopReason = input.stopReason ?? 'waiting_input'
  if (input.last !== undefined) {
    return {
      ...input.last,
      ok: false,
      stopReason,
      executions: input.executions,
      decisions: input.decisions,
      ...(input.clarification === undefined ? {} : { clarification: input.clarification }),
    }
  }
  return {
    ok: false,
    goalId: input.goalId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    agent: input.agent,
    stopReason,
    verdict: 'not_run',
    durationMs: 0,
    executions: input.executions,
    decisions: input.decisions,
    ...(input.clarification === undefined ? {} : { clarification: input.clarification }),
  }
}
