import { afterEach, describe, expect, it } from 'vitest'
import {
  claimDecisionPoint,
  completeDecisionPoint,
  DECISION_CLAIM_LEASE_MS,
  DEFAULT_MAX_CLAIM_ATTEMPTS,
  enqueueDecisionPoint,
  listDecisionPoints,
  reclaimExpiredDecisionPoints,
  renewDecisionClaim,
} from '../../src/runtime/decision-queue'
import { listDecisions } from '../../src/runtime/decision-record'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

const T0 = new Date('2026-01-01T00:00:00.000Z')

/** T0 之后 n 分钟。 */
function at(n: number): Date {
  return new Date(T0.getTime() + n * 60_000)
}

function seed(database: Db, goalId = 'g1', dedupeKey = 'g1:k'): void {
  enqueueDecisionPoint(database, { goalId, reason: 'subtask_terminal', dedupeKey })
}

describe('决策点 claim 租约', () => {
  it('claim 使用注入的时钟，未过期不被回收', () => {
    const database = db()
    seed(database)

    const claimed = claimDecisionPoint(database, 'g1', 'brain-a', T0)
    expect(claimed?.status).toBe('claimed')
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.claimToken).toBeTypeOf('string')
    expect(claimed?.claimedAt).toBe(T0.toISOString())

    const beforeExpiry = new Date(T0.getTime() + DECISION_CLAIM_LEASE_MS - 1_000)
    expect(reclaimExpiredDecisionPoints(database, { now: beforeExpiry })).toEqual([])
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('claimed')
  })

  it('过期回收后可重新领取；旧 token 不能完成新的 claim', () => {
    const database = db()
    seed(database)

    const first = claimDecisionPoint(database, 'g1', 'brain-a', T0)
    expect(first?.claimToken).toBeDefined()

    expect(reclaimExpiredDecisionPoints(database, { now: at(4) })).toEqual([first?.id])
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('pending')
    expect(listDecisionPoints(database, 'g1')[0]?.claimToken).toBeUndefined()

    const second = claimDecisionPoint(database, 'g1', 'brain-b', at(4))
    expect(second?.id).toBe(first?.id)
    expect(second?.claimToken).not.toBe(first?.claimToken)
    expect(second?.attempts).toBe(2)

    /* 关键不变量：旧持有者不能把新持有者的行标成完成。 */
    expect(
      completeDecisionPoint(database, first?.id ?? '', 'done', {
        claimToken: first?.claimToken ?? '',
      }),
    ).toBe(false)
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('claimed')

    expect(
      completeDecisionPoint(database, second?.id ?? '', 'done', {
        claimToken: second?.claimToken ?? '',
      }),
    ).toBe(true)
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('done')
  })

  it('回收按 Goal 收窄：不会打断其他 Goal 的进行中回合', () => {
    const database = db()
    seed(database, 'g1', 'g1:k')
    seed(database, 'g2', 'g2:k')

    claimDecisionPoint(database, 'g1', 'brain-a', T0)
    const other = claimDecisionPoint(database, 'g2', 'brain-b', T0)

    expect(reclaimExpiredDecisionPoints(database, { goalId: 'g1', now: at(4) })).toHaveLength(1)
    expect(listDecisionPoints(database, 'g2')[0]?.status).toBe('claimed')
    expect(listDecisionPoints(database, 'g2')[0]?.claimToken).toBe(other?.claimToken)
  })

  it('续租只认持有该 token 的执行者，续租后不会因原租约到期被回收', () => {
    const database = db()
    seed(database)
    const claimed = claimDecisionPoint(database, 'g1', 'brain-a', T0)

    expect(renewDecisionClaim(database, claimed?.id ?? '', 'not-this-one', at(2))).toBe(false)
    expect(renewDecisionClaim(database, claimed?.id ?? '', claimed?.claimToken ?? '', at(2))).toBe(
      true,
    )

    /* T0+4min 已超过 T0 起算的租约，但续租点 T0+2min 仍在窗口内。 */
    expect(reclaimExpiredDecisionPoints(database, { now: at(4) })).toEqual([])
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('claimed')
  })

  it('claim 不再隐式回收其他 Goal 的过期 claim', () => {
    const database = db()
    seed(database, 'g2', 'g2:k')
    claimDecisionPoint(database, 'g2', 'brain-b', T0)

    seed(database, 'g1', 'g1:k')
    claimDecisionPoint(database, 'g1', 'brain-a', at(99))

    /* 若 claim 里隐式回收，g2 会被打回 pending。 */
    expect(listDecisionPoints(database, 'g2')[0]?.status).toBe('claimed')
  })

  it('attempts 到上限后不再重领，并判 failed 交人工/恢复', () => {
    const database = db()
    seed(database)

    claimDecisionPoint(database, 'g1', 'brain', T0)
    for (let round = 1; round < DEFAULT_MAX_CLAIM_ATTEMPTS; round += 1) {
      expect(reclaimExpiredDecisionPoints(database, { now: at(round * 4) })).toHaveLength(1)
      const again = claimDecisionPoint(database, 'g1', 'brain', at(round * 4))
      expect(again?.attempts).toBe(round + 1)
    }

    expect(listDecisionPoints(database, 'g1')[0]?.attempts).toBe(DEFAULT_MAX_CLAIM_ATTEMPTS)
    expect(reclaimExpiredDecisionPoints(database, { now: at(99) })).toHaveLength(1)
    expect(claimDecisionPoint(database, 'g1', 'brain', at(99))).toBeUndefined()
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('failed')
  })

  it('升级前遗留的 claimed 行（无 claim_token）可被回收', () => {
    const database = db()
    seed(database)
    /* 模拟迁移 016 之前的旧行：claimed 但没有 token，也没有 attempts。 */
    database
      .prepare(
        `UPDATE decision_queue
         SET status = 'claimed', claimed_at = ?, claimed_by = 'legacy'
         WHERE goal_id = 'g1'`,
      )
      .run(T0.toISOString())

    expect(reclaimExpiredDecisionPoints(database, { now: at(1) })).toHaveLength(1)
    const reclaimed = claimDecisionPoint(database, 'g1', 'brain-new', at(1))
    expect(reclaimed?.claimToken).toBeTypeOf('string')
    expect(reclaimed?.claimedBy).toBe('brain-new')
  })

  it('回收与 attempts 耗尽都留痕到 DecisionRecord（P0 审计）', () => {
    const database = db()
    seed(database)
    const claimed = claimDecisionPoint(database, 'g1', 'brain-a', T0)

    /* 租约过期回收 → 必须留一条可查的决策记录。 */
    reclaimExpiredDecisionPoints(database, { now: at(5) })
    const afterReclaim = listDecisions(database, 'g1')
    expect(afterReclaim).toHaveLength(1)
    expect(afterReclaim[0]?.type).toBe('retry')
    expect(afterReclaim[0]?.rationale).toContain('租约过期')
    expect(afterReclaim[0]?.inputs['decisionPointId']).toBe(claimed?.id)

    /* attempts 耗尽、被判 failed 时也要留痕。 */
    for (let round = 1; round < DEFAULT_MAX_CLAIM_ATTEMPTS; round += 1) {
      const claimedAt = at(round * 4)
      expect(claimDecisionPoint(database, 'g1', 'brain', claimedAt)?.attempts).toBe(round + 1)
      /* 租约 3 分钟：向后推 4 分钟才真的过期。 */
      reclaimExpiredDecisionPoints(database, { now: at(round * 4 + 4) })
    }
    expect(claimDecisionPoint(database, 'g1', 'brain', at(900))).toBeUndefined()
    const exhausted = listDecisions(database, 'g1').filter((item) =>
      item.rationale.includes('次数耗尽'),
    )
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0]?.type).toBe('abort')
  })
})
