import { asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../domain/ids'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'

/**
 * 重试耗尽后的最终收敛：只有到这里才把 Subtask/Task/Goal 置 failed。
 * Execution 已由 runAcpTask 在每次失败时单独置 failed。
 */
export function failTask(
  db: Db,
  input: { taskId: string; goalId: string; subtaskId?: string },
): void {
  let state = loadState(db)
  const task = state.tasks[input.taskId]
  if (
    task !== undefined &&
    (task.status === 'running' ||
      task.status === 'waiting_input' ||
      task.status === 'waiting_approval')
  ) {
    if (input.subtaskId !== undefined) {
      const subtask = state.subtasks[input.subtaskId]
      if (
        subtask !== undefined &&
        (subtask.status === 'running' ||
          subtask.status === 'waiting_input' ||
          subtask.status === 'waiting_approval')
      ) {
        state = appendEvent(db, state, {
          type: 'subtask.status',
          subtaskId: asSubtaskId(input.subtaskId),
          to: 'failed',
          at: asTimestamp(new Date().toISOString()),
        }).state
      }
    }
    state = appendEvent(db, state, {
      type: 'task.status',
      taskId: asTaskId(input.taskId),
      to: 'failed',
      at: asTimestamp(new Date().toISOString()),
    }).state
  }
  const goal = state.goals[input.goalId]
  if (goal !== undefined && goal.status === 'active') {
    appendEvent(db, state, {
      type: 'goal.status',
      goalId: asGoalId(input.goalId),
      to: 'failed',
      at: asTimestamp(new Date().toISOString()),
    })
  }
}

export function failGoal(db: Db, goalId: string): void {
  const state = loadState(db)
  const goal = state.goals[goalId]
  if (goal === undefined || goal.status !== 'active') return
  appendEvent(db, state, {
    type: 'goal.status',
    goalId: asGoalId(goalId),
    to: 'failed',
    at: asTimestamp(new Date().toISOString()),
  })
}
