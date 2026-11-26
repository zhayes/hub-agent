import { TaskState } from '@a2a-js/sdk'
import type { TaskStatus } from '../../domain/status'

/**
 * 本地 Task 状态 → A2A `TaskState`（PRD §7.6.2 的实现）。
 *
 * 注意 A2A 没有 `paused`：暂停仍是“还没结束”，对外报 `WORKING`，
 * 不发明私有状态——否则对端无法解释。
 */
export function toTaskState(status: TaskStatus): TaskState {
  switch (status) {
    case 'draft':
    case 'planning':
    case 'ready':
      return TaskState.TASK_STATE_SUBMITTED
    case 'running':
    case 'paused':
      return TaskState.TASK_STATE_WORKING
    case 'waiting_input':
      return TaskState.TASK_STATE_INPUT_REQUIRED
    case 'waiting_approval':
      return TaskState.TASK_STATE_AUTH_REQUIRED
    case 'completed':
      return TaskState.TASK_STATE_COMPLETED
    case 'failed':
      return TaskState.TASK_STATE_FAILED
    case 'canceled':
      return TaskState.TASK_STATE_CANCELED
  }
}

/** 终态：SDK 会在这些状态上关闭事件流 / 拒绝重订阅。 */
export function isTerminalTaskState(state: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  )
}

/** 中断态：可续，不关流（`ExecutionEventQueue` 在此终止但任务仍可继续）。 */
export function isInterruptedTaskState(state: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED
  )
}
