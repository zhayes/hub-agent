import { hasEvidence, isVerified } from './entities'
import type { DomainState } from './machine'
import { isActiveExecution } from './status'

/**
 * 不变量（ARCHITECTURE §6.1）。
 *
 * 这里是"安全网"：迁移守卫已经保证了大部分情况，
 * 但任何一次非法写入（例如直接改库、事件回放错位）都应该在这里暴露。
 *
 * 未在此实现的条目与原因：
 *   I4（同一 WorkspaceLease 下写入型 Execution ≤ 1）：依赖租约模型，M7 落地。
 *   I6（终态不可逆）：无法从单个快照判定，由迁移表强制（checkTransition 的 TERMINAL）。
 */
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I5'

export interface InvariantViolation {
  id: InvariantId
  message: string
  refs: string[]
}

export function checkInvariants(state: DomainState): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const subtasks = Object.values(state.subtasks)
  const executions = Object.values(state.executions)
  const verifications = Object.values(state.verifications)

  // I1：Task.completed ⇒ 所有必需 Subtask 均为 succeeded / skipped
  for (const task of Object.values(state.tasks)) {
    if (task.status !== 'completed') continue
    const pending = subtasks.filter(
      (subtask) =>
        subtask.taskId === task.id &&
        subtask.required &&
        subtask.status !== 'succeeded' &&
        subtask.status !== 'skipped',
    )
    if (pending.length > 0) {
      violations.push({
        id: 'I1',
        message: `task ${task.id} 已 completed，但仍有未收敛的必需子任务`,
        refs: [task.id, ...pending.map((subtask) => subtask.id)],
      })
    }
  }

  // I2：Subtask.succeeded ⇒ 存在成功执行，且该执行有通过验收
  for (const subtask of subtasks) {
    if (subtask.status !== 'succeeded') continue
    const ok = executions.some(
      (execution) =>
        execution.subtaskId === subtask.id &&
        execution.status === 'succeeded' &&
        verifications.some((run) => run.executionId === execution.id && isVerified(run)),
    )
    if (!ok) {
      violations.push({
        id: 'I2',
        message: `subtask ${subtask.id} 已 succeeded，但缺少「成功执行 + 通过验收」`,
        refs: [subtask.id],
      })
    }
  }

  // I3：Execution.succeeded ⇒ 有证据
  for (const execution of executions) {
    if (execution.status === 'succeeded' && !hasEvidence(execution.evidence)) {
      violations.push({
        id: 'I3',
        message: `execution ${execution.id} 已 succeeded，但没有证据`,
        refs: [execution.id],
      })
    }
  }

  // I5：Task.paused ⇒ 其下没有活跃 Execution
  const subtaskTask = new Map(subtasks.map((subtask) => [subtask.id, subtask.taskId]))
  for (const task of Object.values(state.tasks)) {
    if (task.status !== 'paused') continue
    const active = executions.filter(
      (execution) =>
        isActiveExecution(execution.status) && subtaskTask.get(execution.subtaskId) === task.id,
    )
    if (active.length > 0) {
      violations.push({
        id: 'I5',
        message: `task ${task.id} 已 paused，但其下仍有活跃执行`,
        refs: [task.id, ...active.map((execution) => execution.id)],
      })
    }
  }

  return violations
}

export function assertInvariants(state: DomainState): void {
  const violations = checkInvariants(state)
  if (violations.length > 0) {
    const summary = violations
      .map((violation) => `${violation.id}: ${violation.message}`)
      .join('; ')
    throw new Error(`不变量被破坏 → ${summary}`)
  }
}
