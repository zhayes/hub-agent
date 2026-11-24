import { asExecutionId, asSubtaskId, asTaskId, asTimestamp } from '../../domain/ids'
import { isActiveExecution } from '../../domain/status'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'

export interface CancelResult {
  taskId: string
  executions: string[]
  subtasks: string[]
}

/** 取消任务：活跃 Execution/Subtask 先取消，再取消 Task；现场保留，由 task clean 清理。 */
export function cancelTask(db: Db, taskId: string): CancelResult {
  let state = loadState(db)
  const task = state.tasks[taskId]
  if (
    task === undefined ||
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'canceled'
  ) {
    return { taskId, executions: [], subtasks: [] }
  }
  const executions = Object.values(state.executions).filter(
    (execution) => execution.taskId === taskId && isActiveExecution(execution.status),
  )
  const subtasks = Object.values(state.subtasks).filter(
    (subtask) =>
      subtask.taskId === taskId &&
      !['succeeded', 'failed', 'canceled', 'skipped'].includes(subtask.status),
  )
  const at = () => asTimestamp(new Date().toISOString())

  for (const execution of executions) {
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: asExecutionId(execution.id),
      to: 'canceled',
      at: at(),
    }).state
  }
  for (const subtask of subtasks) {
    state = appendEvent(db, state, {
      type: 'subtask.status',
      subtaskId: asSubtaskId(subtask.id),
      to: 'canceled',
      at: at(),
    }).state
  }
  appendEvent(db, state, {
    type: 'task.status',
    taskId: asTaskId(taskId),
    to: 'canceled',
    at: at(),
  })
  return {
    taskId,
    executions: executions.map((execution) => execution.id),
    subtasks: subtasks.map((subtask) => subtask.id),
  }
}
