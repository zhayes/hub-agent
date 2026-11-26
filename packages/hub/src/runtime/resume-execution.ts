import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AgentHost } from '../agent-host/agent-host'
import { asSubtaskId, asTaskId, asTimestamp } from '../domain/ids'
import type { SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { hubDir } from '../shared/paths'
import type { Db } from '../storage/db'
import { getExecutionResume } from '../storage/queries/execution-resume'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { failTask } from './recovery/fail'
import { runVerification, type VerificationOutcome } from './verify/runner'
import { completeTaskAfterDelivery } from './workspace/finalize'

export interface ResumeExecutionOptions {
  db: Db
  provider: SandboxProvider
  approvalId: string
  now?: Date
}

export interface ResumeExecutionResult {
  ok: boolean
  executionId: string
  taskId: string
  goalId: string
  verdict: 'pass' | 'fail' | 'manual_required'
}

/**
 * 审批通过后原地续跑同一个 execution：
 * 不重开 Agent、不新建 execution，只把被沙箱拒绝的验收命令放宽写范围后重放。
 * 现场（worktree + checks）在 runAcpTask 验收前已落 execution_resume。
 */
export async function resumeExecution(
  options: ResumeExecutionOptions,
): Promise<ResumeExecutionResult> {
  const db = options.db
  const state = loadState(db)
  const approval = state.approvals[options.approvalId]
  if (approval === undefined) {
    throw new HubError('ACTION_REJECTED', 'Approval 不存在', { approvalId: options.approvalId })
  }
  if (approval.status !== 'approved') {
    throw new HubError('ACTION_REJECTED', 'Approval 还没有批准，不能续跑', {
      status: approval.status,
    })
  }
  if (approval.executionId === undefined) {
    throw new HubError('ACTION_REJECTED', '这条 Approval 没有关联执行', { approvalId: approval.id })
  }
  const execution = state.executions[approval.executionId]
  if (execution === undefined) {
    throw new HubError('ACTION_REJECTED', '执行记录不存在', { executionId: approval.executionId })
  }
  if (execution.status !== 'waiting_permission') {
    throw new HubError('ACTION_REJECTED', '执行不在等待审批状态，无法精确续跑', {
      status: execution.status,
    })
  }
  const plan = getExecutionResume(db, execution.id)
  if (plan === undefined) {
    throw new HubError('ACTION_REJECTED', '这次执行没有留下可续跑的验收现场', {
      executionId: execution.id,
    })
  }
  if (!existsSync(plan.worktree)) {
    throw new HubError('ACTION_REJECTED', '工作区已回收，无法精确续跑；请重新执行', {
      worktree: plan.worktree,
    })
  }

  const at = (): ReturnType<typeof asTimestamp> =>
    asTimestamp((options.now ?? new Date()).toISOString())
  let next = appendEvent(db, state, {
    type: 'execution.status',
    executionId: execution.id,
    to: 'running',
    at: at(),
  }).state

  const goalId = String(state.tasks[execution.taskId]?.goalId ?? '')
  const host = new AgentHost({ provider: options.provider })
  let verification: VerificationOutcome
  try {
    verification = await runVerification({
      executionId: execution.id,
      worktree: plan.worktree,
      checks: plan.checks,
      ...(execution.evidence?.changedFiles === undefined
        ? {}
        : { changedFiles: execution.evidence.changedFiles }),
      artifactDir: join(hubDir(), 'artifacts', execution.id),
      host,
      /* 审批放宽的是写范围：验收命令可以写工作区（仍受沙箱约束）。 */
      allowedWrite: [plan.worktree],
    })
  } catch (error) {
    appendEvent(db, next, {
      type: 'execution.status',
      executionId: execution.id,
      to: 'failed',
      at: at(),
    })
    failTask(db, {
      taskId: execution.taskId,
      goalId,
      subtaskId: execution.subtaskId,
      failGoal: false,
    })
    throw error
  }
  next = appendEvent(db, next, { type: 'verification.recorded', run: verification.run }).state

  const passed = verification.run.verdict === 'pass'
  appendEvent(db, next, {
    type: 'execution.status',
    executionId: execution.id,
    to: passed ? 'succeeded' : 'failed',
    at: at(),
  })

  if (!passed) {
    failTask(db, {
      taskId: execution.taskId,
      goalId: String(state.tasks[execution.taskId]?.goalId ?? ''),
      subtaskId: execution.subtaskId,
    })
    return {
      ok: false,
      executionId: execution.id,
      taskId: execution.taskId,
      goalId: String(state.tasks[execution.taskId]?.goalId ?? ''),
      verdict: verification.run.verdict,
    }
  }

  let current = loadState(db)
  const subtask = current.subtasks[execution.subtaskId]
  if (subtask !== undefined && subtask.status === 'waiting_approval') {
    current = appendEvent(db, current, {
      type: 'subtask.status',
      subtaskId: asSubtaskId(execution.subtaskId),
      to: 'running',
      at: at(),
    }).state
  }
  if (subtask !== undefined && subtask.status !== 'succeeded') {
    current = appendEvent(db, current, {
      type: 'subtask.status',
      subtaskId: asSubtaskId(execution.subtaskId),
      to: 'succeeded',
      at: at(),
    }).state
  }
  const task = current.tasks[execution.taskId]
  if (task !== undefined && task.status === 'waiting_approval') {
    current = appendEvent(db, current, {
      type: 'task.status',
      taskId: asTaskId(execution.taskId),
      to: 'running',
      at: at(),
    }).state
  }
  completeTaskAfterDelivery(db, execution.taskId, String(task?.goalId ?? ''))

  return {
    ok: true,
    executionId: execution.id,
    taskId: execution.taskId,
    goalId: String(task?.goalId ?? ''),
    verdict: verification.run.verdict,
  }
}
