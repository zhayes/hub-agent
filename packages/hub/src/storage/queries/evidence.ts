import type { Approval, Execution, Subtask, Task, VerificationRun } from '../../domain/entities'
import type { Db } from '../db'
import { loadState } from './state'

export interface TaskEvidence {
  task: Task
  subtasks: Subtask[]
  executions: Execution[]
  verifications: VerificationRun[]
  approvals: Approval[]
}

/**
 * 任务证据视图：只读，供 `task show --evidence` 与后续 HTTP 使用。
 * 数据量按单任务收敛；M5 不做分页/虚拟滚动。
 */
export function getTaskEvidence(db: Db, taskId: string): TaskEvidence | undefined {
  const state = loadState(db)
  const task = state.tasks[taskId]
  if (task === undefined) return undefined

  const subtasks = Object.values(state.subtasks).filter((subtask) => subtask.taskId === task.id)
  const executions = Object.values(state.executions).filter(
    (execution) => execution.taskId === task.id,
  )
  const executionIds = new Set(executions.map((execution) => execution.id))
  const verifications = Object.values(state.verifications).filter((run) =>
    executionIds.has(run.executionId),
  )
  const approvals = Object.values(state.approvals).filter((approval) => approval.taskId === task.id)

  return { task, subtasks, executions, verifications, approvals }
}
