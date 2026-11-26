import type { Db } from '../../storage/db'
import { reclaimExpiredDecisionPoints } from '../decision-queue'
import { reclaimExpiredDispatches } from '../dispatch/queue'
import { drainDispatches } from '../dispatch/runner'
import type { DispatchExecutor, DispatchIntent } from '../dispatch/types'
import {
  type ReconcileRemotesOptions,
  type ReconcileReport,
  reconcileRemoteTasks,
} from '../remote-reconcile'

export interface SchedulerDeps {
  /**
   * 按意图构造执行器。生产直接用 `createLocalAcpExecutor`；
   * 测试可注入假实现。之所以按意图构造，是因为执行所需上下文在意图的 payload 里。
   */
  createExecutor: (intent: DispatchIntent) => DispatchExecutor
  now?: Date
  /** 单次 tick 最多跑几条派发，避免一次占用太久。 */
  maxDispatches?: number
  /**
   * 远端对账。只有配置了出站 peer 解析器时才传——未配置时 daemon 行为不变。
   * `db` 与 `now` 由 tick 注入，调用方只给解析器与可选项。
   */
  reconcile?: Omit<ReconcileRemotesOptions, 'db' | 'now'>
}

export interface SchedulerReport {
  reclaimedDecisionPoints: string[]
  reclaimedDispatches: string[]
  handled: string[]
  failed: string[]
  requeued: string[]
  /**
   * 仍有 pending 决策点、但当前没有可派发意图的 Goal。
   * 这些 Goal 需要跑一个 Brain 回合才能推进——调度器只负责报出来，
   * 不在这里伪造 Brain 决策（见 ADR 0027）。
   */
  pendingDecisionGoals: string[]
  /** 本轮远端对账结果；未配置 `reconcile` 时为 undefined。 */
  reconciled?: ReconcileReport
}

/**
 * 调度器的一次 tick（daemon 内常驻调用）。
 *
 * 顺序有意义：先回收过期 claim（可能是上次进程死亡留下的），再消费派发意图。
 * 只有“派发”这一侧会被真正执行；决策点一侧仍需 Brain 回合，故只做上报。
 */
export async function runSchedulerTick(db: Db, deps: SchedulerDeps): Promise<SchedulerReport> {
  const now = deps.now ?? new Date()

  const reclaimedDecisionPoints = reclaimExpiredDecisionPoints(db, { now })
  const reclaimedDispatches = reclaimExpiredDispatches(db, { now })

  const executor: DispatchExecutor = (intent) => deps.createExecutor(intent)(intent)
  const drained = await drainDispatches(db, {
    executor,
    now,
    max: deps.maxDispatches ?? 20,
  })

  const rows = db
    .prepare(
      `SELECT DISTINCT goal_id FROM decision_queue
       WHERE status = 'pending'
       ORDER BY goal_id ASC`,
    )
    .all() as Array<{ goal_id: string }>

  const reconciled =
    deps.reconcile === undefined
      ? undefined
      : await reconcileRemoteTasks({ ...deps.reconcile, db, now })

  return {
    reclaimedDecisionPoints,
    reclaimedDispatches,
    handled: drained.handled,
    failed: drained.failed,
    requeued: drained.requeued,
    pendingDecisionGoals: rows.map((row) => row.goal_id),
    ...(reconciled === undefined ? {} : { reconciled }),
  }
}
