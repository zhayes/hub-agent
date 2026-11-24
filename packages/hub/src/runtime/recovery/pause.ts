import { asExecutionId, asSubtaskId, asTaskId, asTimestamp } from '../../domain/ids'
import type { ExecutionStatus, SubtaskStatus, TaskStatus } from '../../domain/status'
import { isActiveExecution } from '../../domain/status'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'

export interface PauseResult {
  taskId: string
  executions: string[]
  subtasks: string[]
}

/**
 * Task 暂停：先把活跃 Execution 转 paused，再把 Subtask/Task 转 paused。
 * paused 继续持有 WorkspaceLease，不释放现场。
 */
export function pauseTask(db: Db, taskId: string, _reason: string): PauseResult {
  let state = loadState(db)
  const task = state.tasks[taskId]
  if (task === undefined) return { taskId, executions: [], subtasks: [] }
  if (
    task.status !== 'running' &&
    task.status !== 'waiting_input' &&
    task.status !== 'waiting_approval'
  ) {
    return { taskId, executions: [], subtasks: [] }
  }
  const executions = Object.values(state.executions).filter(
    (execution) => execution.taskId === taskId && isActiveExecution(execution.status),
  )
  const subtasks = Object.values(state.subtasks).filter(
    (subtask) =>
      subtask.taskId === taskId && (subtask.status === 'running' || subtask.status === 'assigned'),
  )
  const at = () => asTimestamp(new Date().toISOString())

  for (const execution of executions) {
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: asExecutionId(execution.id),
      to: 'paused' satisfies ExecutionStatus,
      at: at(),
    }).state
  }
  for (const subtask of subtasks) {
    state = appendEvent(db, state, {
      type: 'subtask.status',
      subtaskId: asSubtaskId(subtask.id),
      to: 'paused' satisfies SubtaskStatus,
      at: at(),
    }).state
  }
  state = appendEvent(db, state, {
    type: 'task.status',
    taskId: asTaskId(taskId),
    to: 'paused' satisfies TaskStatus,
    at: at(),
  }).state
  return {
    taskId,
    executions: executions.map((execution) => execution.id),
    subtasks: subtasks.map((subtask) => subtask.id),
    // reason 目前不落事件；调用方写入 DecisionRecord/日志
  }
}

/** 恢复顺序与暂停相反：Task → running，再 Subtask/Execution → running（PRD §6.5.6）。 */
export function resumeTask(db: Db, taskId: string): PauseResult {
  let state = loadState(db)
  const task = state.tasks[taskId]
  if (task === undefined || task.status !== 'paused') {
    return { taskId, executions: [], subtasks: [] }
  }
  const subtasks = Object.values(state.subtasks).filter(
    (subtask) => subtask.taskId === taskId && subtask.status === 'paused',
  )
  const executions = Object.values(state.executions).filter(
    (execution) =>
      execution.taskId === taskId &&
      execution.status === 'paused' &&
      subtasks.some((subtask) => subtask.id === execution.subtaskId),
  )
  const at = () => asTimestamp(new Date().toISOString())

  state = appendEvent(db, state, {
    type: 'task.status',
    taskId: asTaskId(taskId),
    to: 'running',
    at: at(),
  }).state
  for (const subtask of subtasks) {
    state = appendEvent(db, state, {
      type: 'subtask.status',
      subtaskId: asSubtaskId(subtask.id),
      to: 'running',
      at: at(),
    }).state
  }
  for (const execution of executions) {
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: asExecutionId(execution.id),
      to: 'running',
      at: at(),
    }).state
  }
  return {
    taskId,
    executions: executions.map((execution) => execution.id),
    subtasks: subtasks.map((subtask) => subtask.id),
  }
}
