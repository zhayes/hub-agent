import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { lastSeq } from '../storage/write/events'
import { recordDecision } from './decision-record'

export type DecisionPointStatus = 'pending' | 'claimed' | 'done' | 'failed'

/**
 * 默认租约：Brain 回合预算 `step` 90s + `explain`，留一倍余量。
 * 超过这个时长的 claim 视为「持有者已死」，由恢复扫描回收。
 */
export const DECISION_CLAIM_LEASE_MS = 180_000

/**
 * 同一决策点最多被 claim 几次。超过即判 failed，交人工/恢复处理，
 * 避免「回合总是超过租约」导致无限重复决策。
 */
export const DEFAULT_MAX_CLAIM_ATTEMPTS = 5

export interface DecisionPoint {
  id: string
  goalId: string
  dedupeKey: string
  reason: string
  status: DecisionPointStatus
  payload?: unknown
  stateVersion?: number
  createdAt: string
  claimedAt?: string
  claimedBy?: string
  /** 本次 claim 的持有凭证；完成/续租必须回传。 */
  claimToken?: string
  /** 已被 claim 的次数（含过期回收后的重领）。 */
  attempts: number
}

interface QueueRow {
  id: string
  goal_id: string
  dedupe_key: string
  reason: string
  status: string
  payload: string | null
  state_version: number | null
  created_at: string
  claimed_at: string | null
  claimed_by: string | null
  claim_token: string | null
  attempts: number
}

function toPoint(row: QueueRow): DecisionPoint {
  let payload: unknown
  if (row.payload !== null) {
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = undefined
    }
  }
  return {
    id: row.id,
    goalId: row.goal_id,
    dedupeKey: row.dedupe_key,
    reason: row.reason,
    status: row.status as DecisionPointStatus,
    ...(payload === undefined ? {} : { payload }),
    ...(row.state_version === null ? {} : { stateVersion: row.state_version }),
    createdAt: row.created_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    attempts: row.attempts,
  }
}

export interface EnqueueDecisionPointInput {
  goalId: string
  reason: string
  dedupeKey: string
  payload?: unknown
}

/** 决策点按 dedupeKey 去重；重复投递只保留一行。 */
export function enqueueDecisionPoint(
  db: Db,
  input: EnqueueDecisionPointInput,
): { point: DecisionPoint; created: boolean } {
  const id = newId()
  const now = new Date().toISOString()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO decision_queue (
         id, goal_id, dedupe_key, reason, status, payload, state_version, created_at
       ) VALUES (@id, @goalId, @dedupeKey, @reason, 'pending', @payload, @stateVersion, @createdAt)`,
    )
    .run({
      id,
      goalId: input.goalId,
      dedupeKey: input.dedupeKey,
      reason: input.reason,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      stateVersion: lastSeq(db),
      createdAt: now,
    })
  const row = db
    .prepare('SELECT * FROM decision_queue WHERE dedupe_key = ?')
    .get(input.dedupeKey) as QueueRow | undefined
  if (row === undefined) {
    throw new HubError('DB_UNAVAILABLE', `决策点写入后读不到：${input.dedupeKey}`)
  }
  return { point: toPoint(row), created: result.changes > 0 }
}

/**
 * 单写者 claim：只把一行 pending 改成 claimed，并生成新的 `claimToken`。
 *
 * 这里**不做**过期回收——回收是恢复扫描/调度器的职责。否则任意一次 claim
 * 都会打断其他 Goal 的进行中回合（同一进程里多个 Goal 共享队列）。
 */
export function claimDecisionPoint(
  db: Db,
  goalId: string,
  claimedBy: string,
  now = new Date(),
  maxAttempts = DEFAULT_MAX_CLAIM_ATTEMPTS,
): DecisionPoint | undefined {
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    throw new HubError('CONFIG_INVALID', 'maxAttempts 必须为正数', { maxAttempts })
  }
  return db.transaction((): DecisionPoint | undefined => {
    const rows = db
      .prepare(
        `SELECT * FROM decision_queue
         WHERE goal_id = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT 50`,
      )
      .all(goalId) as QueueRow[]

    for (const row of rows) {
      if (row.attempts >= maxAttempts) {
        /* 反复过期重领到这个数说明持有一侧一直没跑完：判失败，交人工/恢复。 */
        db.prepare(
          `UPDATE decision_queue
           SET status = 'failed', finished_at = ?, error = 'claim attempts exhausted'
           WHERE id = ? AND status = 'pending'`,
        ).run(now.toISOString(), row.id)
        recordDecision(db, {
          goalId: row.goal_id,
          type: 'abort',
          rationale: '决策点 claim 次数耗尽，交人工/恢复',
          inputs: {
            decisionPointId: row.id,
            dedupeKey: row.dedupe_key,
            attempts: row.attempts,
            maxAttempts,
          },
        })
        continue
      }

      const token = newId()
      const info = db
        .prepare(
          `UPDATE decision_queue
           SET status = 'claimed', claimed_at = ?, claimed_by = ?, claim_token = ?,
               attempts = attempts + 1
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now.toISOString(), claimedBy, token, row.id)
      if (info.changes === 0) continue

      const claimed = db
        .prepare('SELECT * FROM decision_queue WHERE id = ?')
        .get(row.id) as QueueRow
      return toPoint(claimed)
    }
    return undefined
  })()
}

/**
 * 续租（heartbeat）：只有持有该 `claimToken` 的执行者能延长租约。
 * 返回 `false` 表示租约已被回收或被别人接管，调用方应丢弃自己的工作。
 */
export function renewDecisionClaim(
  db: Db,
  id: string,
  claimToken: string,
  now = new Date(),
): boolean {
  const info = db
    .prepare(
      `UPDATE decision_queue SET claimed_at = ?
       WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(now.toISOString(), id, claimToken)
  return info.changes > 0
}

/**
 * 收尾：完成/失败必须匹配 `id + claimToken + status = 'claimed'`。
 * 返回 `false` 表示这次 claim 已失效——调用方不得把本轮结果当成权威。
 */
export function completeDecisionPoint(
  db: Db,
  id: string,
  status: Extract<DecisionPointStatus, 'done' | 'failed'>,
  options: { claimToken: string; error?: string; now?: Date },
): boolean {
  const info = db
    .prepare(
      `UPDATE decision_queue
       SET status = ?, finished_at = ?, error = ?
       WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(
      status,
      (options.now ?? new Date()).toISOString(),
      options.error ?? null,
      id,
      options.claimToken,
    )
  return info.changes > 0
}

export interface ReclaimOptions {
  /** 只回收该 Goal 的过期 claim；缺省为全部（仅供恢复扫描）。 */
  goalId?: string
  now?: Date
  leaseMs?: number
}

/**
 * 回收过期 claim，把行退回 `pending` 等新的调度者重新领取。
 *
 * 只由恢复扫描/调度器调用，不在业务路径上隐式触发。保留 `attempts`，
 * 让反复回收能被封顶。返回被回收的行 id，供调用方留痕。
 */
export function reclaimExpiredDecisionPoints(db: Db, options: ReclaimOptions = {}): string[] {
  const leaseMs = options.leaseMs ?? DECISION_CLAIM_LEASE_MS
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new HubError('CONFIG_INVALID', 'decision claim lease 必须为正数', { leaseMs })
  }
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - leaseMs).toISOString()
  const scoped = options.goalId !== undefined
  /* `claim_token IS NULL` 是迁移 016 之前遗留的 claim：没有凭证就无法证明
     持有权，升级后一律视为过期，否则这些行永远完成不了也回收不了。 */
  const where = scoped
    ? `status = 'claimed' AND (claim_token IS NULL OR claimed_at <= @cutoff) AND goal_id = @goalId`
    : `status = 'claimed' AND (claim_token IS NULL OR claimed_at <= @cutoff)`
  const params = scoped ? { cutoff, goalId: options.goalId } : { cutoff }

  return db.transaction(() => {
    const expired = db
      .prepare(
        `SELECT id, goal_id, dedupe_key, claimed_by FROM decision_queue WHERE ${where}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(params) as Array<{
      id: string
      goal_id: string
      dedupe_key: string
      claimed_by: string | null
    }>
    if (expired.length === 0) return []

    db.prepare(
      `UPDATE decision_queue
       SET status = 'pending', claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
           error = 'claim lease expired'
       WHERE ${where}`,
    ).run(params)

    /* 回收是状态变更，必须留痕：否则事后无法回答“这个决策点为什么被重跑了”。 */
    for (const row of expired) {
      recordDecision(db, {
        goalId: row.goal_id,
        type: 'retry',
        rationale: `决策点 claim 租约过期（原持有者 ${row.claimed_by ?? '未知'}），已退回待领取`,
        inputs: { decisionPointId: row.id, dedupeKey: row.dedupe_key, leaseMs },
      })
    }

    return expired.map((row) => row.id)
  })()
}

export function listDecisionPoints(db: Db, goalId: string): DecisionPoint[] {
  const rows = db
    .prepare('SELECT * FROM decision_queue WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
    .all(goalId) as QueueRow[]
  return rows.map(toPoint)
}

export function pendingDecisionPoints(db: Db, goalId: string): DecisionPoint[] {
  return listDecisionPoints(db, goalId).filter((point) => point.status === 'pending')
}
