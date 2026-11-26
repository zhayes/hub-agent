import type { Db } from '../../storage/db'
import { enqueueDecisionPoint } from '../decision-queue'
import { claimDispatch, completeDispatch, releaseDispatch } from './queue'
import type { DispatchExecutor, DispatchIntent, DispatchOutcome } from './types'

export interface DrainDispatchesOptions {
  executor: DispatchExecutor
  /** 只处理该 Goal 的意图；缺省为全局。 */
  goalId?: string
  /** 只处理这一条意图（接线到单条派发时用，避免被旧意图抢占）。 */
  intentId?: string
  claimedBy?: string
  now?: Date
  /** 单次最多处理几条，避免一次调用把队列跑干；缺省 50。 */
  max?: number
}

export interface DrainDispatchesReport {
  handled: string[]
  failed: string[]
  /** 已被退回 pending、等下一轮对账的意图（发现已有在途执行时）。 */
  requeued: string[]
  /** true 表示达到 `max` 提前停止，队列里可能还有可执行意图。 */
  truncated: boolean
}

/**
 * 持久化 Dispatcher 的执行循环（C3 骨架）。
 *
 * 语义：
 * 1. 从库里领一条意图（claim + token）；
 * 2. 交给 executor 执行外部副作用——它自己负责把执行结果写库；
 * 3. runner 在同一事务里做「意图收尾 + 写下一决策点」。
 *
 * 为什么收尾和下一决策点要同事务：否则会出现「执行完了但没有任何决策点，
 * Brain 永远不会被唤醒」的半状态，任务静默停住。
 * 为什么不把执行也放进这个事务：执行是异步 I/O，事务里不能等它
 * （仓库硬规则：事务内禁止 I/O）。
 */
export async function drainDispatches(
  db: Db,
  options: DrainDispatchesOptions,
): Promise<DrainDispatchesReport> {
  const max = options.max ?? 50
  const handled: string[] = []
  const failed: string[] = []
  const requeued: string[] = []
  let processed = 0

  while (processed < max) {
    const intent = claimDispatch(db, {
      claimedBy: options.claimedBy ?? 'dispatcher',
      ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
      ...(options.intentId === undefined ? {} : { intentId: options.intentId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (intent === undefined) return { handled, failed, requeued, truncated: false }
    processed += 1

    const token = intent.claimToken
    if (token === undefined) {
      throw new Error(`派发意图 ${intent.id} claim 后缺少 claimToken`)
    }

    const outcome = await execute(options.executor, intent)

    if (outcome.requeue === true) {
      /* 退回后它仍是最老的 pending，继续循环会立刻重领同一条，所以本轮到此为止。 */
      releaseDispatch(db, intent.id, {
        claimToken: token,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      requeued.push(intent.id)
      return { handled, failed, requeued, truncated: false }
    }

    const applied = db.transaction(() => {
      const done = completeDispatch(db, intent.id, {
        claimToken: token,
        status: outcome.ok ? 'done' : 'failed',
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      if (!done) return false

      const next = outcome.nextDecision
      if (next !== undefined) {
        enqueueDecisionPoint(db, {
          goalId: intent.goalId,
          reason: next.reason,
          dedupeKey: next.dedupeKey,
          ...(next.payload === undefined ? {} : { payload: next.payload }),
        })
      }
      return true
    })()

    if (!applied) {
      /* claim 在执期间被回收/接管：本轮结果不再可信，按失败上报。 */
      failed.push(intent.id)
    } else if (outcome.ok) {
      handled.push(intent.id)
    } else {
      failed.push(intent.id)
    }
  }

  return { handled, failed, requeued, truncated: true }
}

async function execute(
  executor: DispatchExecutor,
  intent: DispatchIntent,
): Promise<DispatchOutcome> {
  try {
    return await executor(intent)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
