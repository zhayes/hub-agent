import type { Execution, Goal, Subtask, Task, VerificationRun } from '../../src/domain/entities'
import type { DomainEvent } from '../../src/domain/events'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  asVerificationRunId,
} from '../../src/domain/ids'
import {
  type ApplyOutcome,
  applyEvent,
  type DomainState,
  emptyState,
} from '../../src/domain/machine'

/** 固定时间戳：领域层不产生时间，时间由事件携带 */
export const AT = asTimestamp('2026-01-01T00:00:00.000Z')

export const IDS = {
  goal: asGoalId('g1'),
  task: asTaskId('t1'),
  s1: asSubtaskId('s1'),
  s2: asSubtaskId('s2'),
  e1: asExecutionId('e1'),
  e2: asExecutionId('e2'),
  v1: asVerificationRunId('v1'),
  agent: asAgentId('codex-local'),
}

export function must(outcome: ApplyOutcome): DomainState {
  if (!outcome.ok) {
    throw new Error(`夹具构造失败：${outcome.error.code} ${outcome.error.message}`)
  }
  return outcome.state
}

export function fold(state: DomainState, events: readonly DomainEvent[]): DomainState {
  return events.reduce<DomainState>((current, event) => must(applyEvent(current, event)), state)
}

export const goal: Goal = {
  id: IDS.goal,
  userId: 'u1',
  title: '示例目标',
  intent: '在 utils.ts 里把日期格式化改成 UTC，并跑测试',
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
}

export const task: Task = {
  id: IDS.task,
  goalId: IDS.goal,
  title: '改日期格式化',
  description: '把日期格式化改成 UTC',
  status: 'ready',
  priority: 1,
  acceptanceCriteria: ['测试通过'],
  createdAt: AT,
  updatedAt: AT,
}

export function subtask(id: typeof IDS.s1 | typeof IDS.s2, title: string): Subtask {
  return {
    id,
    taskId: IDS.task,
    title,
    description: title,
    status: 'ready',
    required: true,
    dependencies: [],
    requiredCapabilities: ['coding'],
    priority: 1,
    maxAttempts: 2,
    createdAt: AT,
    updatedAt: AT,
  }
}

export function execution(
  id: typeof IDS.e1 | typeof IDS.e2,
  subtaskId: typeof IDS.s1 | typeof IDS.s2,
): Execution {
  return {
    id,
    taskId: IDS.task,
    subtaskId,
    agentId: IDS.agent,
    status: 'created',
    attempt: 1,
    createdAt: AT,
  }
}

export function verificationRun(
  id: typeof IDS.v1,
  executionId: typeof IDS.e1 | typeof IDS.e2,
  verdict: VerificationRun['verdict'] = 'pass',
): VerificationRun {
  return {
    id,
    executionId,
    checks: [{ checkId: 'c1', kind: 'command', passed: verdict !== 'fail', command: 'pnpm test' }],
    verdict,
    decidedBy: 'runtime',
    createdAt: AT,
  }
}

/** goal + task(ready) + 两个必需子任务(ready) + 两个执行(created) */
export function seed(): DomainState {
  return fold(emptyState, [
    { type: 'goal.created', goal },
    { type: 'task.created', task },
    { type: 'subtask.created', subtask: subtask(IDS.s1, '实现') },
    { type: 'subtask.created', subtask: subtask(IDS.s2, '测试') },
    { type: 'execution.created', execution: execution(IDS.e1, IDS.s1) },
    { type: 'execution.created', execution: execution(IDS.e2, IDS.s2) },
  ])
}

/** 一条执行走到 succeeded（带证据） */
export function succeedExecution(
  state: DomainState,
  executionId: typeof IDS.e1 | typeof IDS.e2,
  runId: typeof IDS.v1,
  verdict: VerificationRun['verdict'] = 'pass',
): DomainState {
  return fold(state, [
    { type: 'execution.status', executionId, to: 'starting', at: AT },
    { type: 'execution.status', executionId, to: 'running', at: AT },
    {
      type: 'execution.evidence',
      executionId,
      evidence: { commitSha: 'abc123', diffstat: '1 file changed', changedFiles: ['utils.ts'] },
    },
    { type: 'execution.status', executionId, to: 'succeeded', at: AT },
    { type: 'verification.recorded', run: verificationRun(runId, executionId, verdict) },
  ])
}

export function succeedSubtask(
  state: DomainState,
  subtaskId: typeof IDS.s1 | typeof IDS.s2,
): DomainState {
  return fold(state, [
    { type: 'subtask.status', subtaskId, to: 'assigned', at: AT },
    { type: 'subtask.status', subtaskId, to: 'running', at: AT },
    { type: 'subtask.status', subtaskId, to: 'succeeded', at: AT },
  ])
}

/** 完整happy path：两个子任务都成功，task 走到 completed */
export function happyPath(): DomainState {
  let state = seed()
  state = succeedExecution(state, IDS.e1, IDS.v1)
  state = succeedSubtask(state, IDS.s1)
  state = succeedExecution(state, IDS.e2, asVerificationRunId('v2'))
  state = succeedSubtask(state, IDS.s2)
  state = fold(state, [
    { type: 'task.status', taskId: IDS.task, to: 'running', at: AT },
    { type: 'task.status', taskId: IDS.task, to: 'completed', at: AT },
  ])
  return state
}
