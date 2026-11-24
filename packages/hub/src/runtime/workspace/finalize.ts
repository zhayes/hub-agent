import { asGoalId, asTaskId, asTimestamp } from '../../domain/ids'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'

/**
 * 交付动作落地后，Task 才能从 running → completed（PRD §6.12.4）。
 * 调用方必须先确认 VerificationRun = pass、无 pending Approval、交付成功。
 */
export function completeTaskAfterDelivery(db: Db, taskId: string, goalId: string): void {
  let state = loadState(db)
  const task = state.tasks[taskId]
  if (task === undefined) return
  if (task.status !== 'running') return

  const subtasks = Object.values(state.subtasks).filter((subtask) => subtask.taskId === task.id)
  if (subtasks.some((subtask) => subtask.required && subtask.status !== 'succeeded')) return

  const at = (): ReturnType<typeof asTimestamp> => asTimestamp(new Date().toISOString())
  state = appendEvent(db, state, {
    type: 'task.status',
    taskId: asTaskId(taskId),
    to: 'completed',
    at: at(),
  }).state
  const goal = state.goals[goalId]
  if (goal !== undefined && goal.status === 'active') {
    appendEvent(db, state, {
      type: 'goal.status',
      goalId: asGoalId(goalId),
      to: 'completed',
      at: at(),
    })
  }
}
