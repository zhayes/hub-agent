import { asExecutionId, asTimestamp } from '../../domain/ids'
import type { ExecutionStatus } from '../../domain/status'
import { isActiveExecution } from '../../domain/status'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'
import { enqueueDecisionPoint } from '../decision-queue'

export interface RecoveryScanOptions {
  now?: Date
  /** 重启后默认认为进程不存在；测试可注入 */
  isProcessAlive?: (executionId: string) => boolean
  /** 租约是否仍有效（目录/branch 存在） */
  isLeaseValid?: (executionId: string) => boolean
}

export interface RecoveryReport {
  unknown: string[]
  decisions: string[]
  skippedAlive: string[]
}

/**
 * 重启恢复扫描（PRD §6.7 / §15.2）：
 *   非终态 Execution 若进程不存在 → unknown（不是 failed）；
 *   写恢复决策点，交 Brain/用户决定继续/回滚/放弃。
 */
export function scanRecovery(db: Db, options: RecoveryScanOptions = {}): RecoveryReport {
  const isAlive = options.isProcessAlive ?? (() => false)
  const leaseValid = options.isLeaseValid ?? (() => true)
  let state = loadState(db)
  const unknown: string[] = []
  const decisions: string[] = []
  const skippedAlive: string[] = []
  const at = () => asTimestamp((options.now ?? new Date()).toISOString())

  for (const execution of Object.values(state.executions).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!isActiveExecution(execution.status)) continue
    if (isAlive(execution.id)) {
      skippedAlive.push(execution.id)
      continue
    }
    if (execution.status === 'paused') continue

    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: asExecutionId(execution.id),
      to: 'unknown' satisfies ExecutionStatus,
      at: at(),
    }).state
    unknown.push(execution.id)

    const task = state.tasks[execution.taskId]
    if (task === undefined) continue
    const point = enqueueDecisionPoint(db, {
      goalId: task.goalId,
      reason: 'recovery',
      dedupeKey: `recovery:${execution.id}`,
      payload: {
        executionId: execution.id,
        previousStatus: execution.status,
        leaseValid: leaseValid(execution.id),
      },
    })
    if (point.created) decisions.push(point.point.id)
  }

  return { unknown, decisions, skippedAlive }
}
