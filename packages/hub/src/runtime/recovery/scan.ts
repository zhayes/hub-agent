import { asExecutionId, asTimestamp } from '../../domain/ids'
import type { ExecutionStatus } from '../../domain/status'
import { EXECUTION_TRANSITIONS, isActiveExecution } from '../../domain/status'
import type { Db } from '../../storage/db'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'
import { enqueueDecisionPoint, reclaimExpiredDecisionPoints } from '../decision-queue'
import { reclaimExpiredDispatches } from '../dispatch/queue'

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
  /** 本次启动回收的过期 claim（租约超时的决策点已退回 pending，等调度者重领）。 */
  reclaimedDecisionPoints: string[]
  /** 同理：过期未收尾的派发意图退回 pending（见 PLAN-A2A §5.4）。 */
  reclaimedDispatches: string[]
  skippedAlive: string[]
  /**
   * 保持原状、本次不处理的执行：
   * 状态机不允许 `→ unknown`（waiting_input / waiting_permission / starting，
   * 强行收敛会抛 EVENT_REJECTED，进而让 daemon 起不来——真实事故），
   * 或缺少 Task 投影、定位不到 Goal 而建不出恢复决策点。
   */
  skippedIncomplete: string[]
}

/**
 * 重启恢复扫描（PRD §6.7 / §15.2）：
 *   非终态 Execution 若进程不存在 → unknown（不是 failed）；
 *   写恢复决策点，交 Brain/用户决定继续/回滚/放弃。
 *
 * 状态迁移与待派发决策点**同一事务**落库：若崩在两者之间，整个事务回滚，
 * Execution 仍是原状态，下次启动会重新处理。否则会留下
 * “已经是 unknown、却没有恢复任务” 的半状态，而扫描只处理活跃执行，
 * 该任务再也没有机会被补上。
 */
export function scanRecovery(db: Db, options: RecoveryScanOptions = {}): RecoveryReport {
  const isAlive = options.isProcessAlive ?? (() => false)
  const leaseValid = options.isLeaseValid ?? (() => true)
  const reclaimedDecisionPoints = reclaimExpiredDecisionPoints(db, {
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const reclaimedDispatches = reclaimExpiredDispatches(db, {
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  let state = loadState(db)
  const unknown: string[] = []
  const decisions: string[] = []
  const skippedAlive: string[] = []
  const skippedIncomplete: string[] = []
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
    // 只有状态机允许的执行才能收敛到 unknown；其余留在原状态，交人工/下次启动。
    if (!EXECUTION_TRANSITIONS[execution.status].includes('unknown')) {
      skippedIncomplete.push(execution.id)
      continue
    }

    const task = state.tasks[execution.taskId]
    if (task === undefined) {
      /* 没有 Task 投影就定位不到 Goal，建不出恢复决策点。
         宁可保持原状，也不要把 Execution 单独置成 unknown 而无人处理。 */
      skippedIncomplete.push(execution.id)
      continue
    }

    /* 租约检查可能读目录/分支，放在事务外（事务内禁止 I/O）。 */
    const payload = {
      executionId: execution.id,
      previousStatus: execution.status,
      leaseValid: leaseValid(execution.id),
    }
    const now = at()

    const committed = db.transaction(() => {
      const next = appendEvent(db, state, {
        type: 'execution.status',
        executionId: asExecutionId(execution.id),
        to: 'unknown' satisfies ExecutionStatus,
        at: now,
      })
      const point = enqueueDecisionPoint(db, {
        goalId: task.goalId,
        reason: 'recovery',
        dedupeKey: `recovery:${execution.id}`,
        payload,
      })
      return { state: next.state, point }
    })()

    state = committed.state
    unknown.push(execution.id)
    if (committed.point.created) decisions.push(committed.point.point.id)
  }

  return {
    unknown,
    decisions,
    reclaimedDecisionPoints,
    reclaimedDispatches,
    skippedAlive,
    skippedIncomplete,
  }
}
