import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { lastSeq } from '../storage/write/events'

export type DecisionPointStatus = 'pending' | 'claimed' | 'done' | 'failed'

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
 * 单写者 claim：只把一行 pending 改成 claimed。
 * 同一进程内 better-sqlite3 是同步的；多进程场景由单实例锁 + 条件更新兜底。
 */
export function claimDecisionPoint(
  db: Db,
  goalId: string,
  claimedBy: string,
): DecisionPoint | undefined {
  return db.transaction((): DecisionPoint | undefined => {
    const row = db
      .prepare(
        `SELECT * FROM decision_queue
         WHERE goal_id = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(goalId) as QueueRow | undefined
    if (row === undefined) return undefined
    const info = db
      .prepare(
        `UPDATE decision_queue
         SET status = 'claimed', claimed_at = ?, claimed_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), claimedBy, row.id)
    if (info.changes === 0) return undefined
    const claimed = db.prepare('SELECT * FROM decision_queue WHERE id = ?').get(row.id) as QueueRow
    return toPoint(claimed)
  })()
}

export function completeDecisionPoint(
  db: Db,
  id: string,
  status: Extract<DecisionPointStatus, 'done' | 'failed'>,
  error?: string,
): void {
  db.prepare(
    `UPDATE decision_queue
     SET status = ?, finished_at = ?, error = ?
     WHERE id = ? AND status = 'claimed'`,
  ).run(status, new Date().toISOString(), error ?? null, id)
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
