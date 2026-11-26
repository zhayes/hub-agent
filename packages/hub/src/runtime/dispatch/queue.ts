import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import type { Db } from '../../storage/db'
import type { DispatchIntent, DispatchStatus, DispatchTarget } from './types'

/**
 * 派发租约比决策点长得多：一次 ACP 执行通常以分钟计。
 * 超过这个时长的 claim 视为持有者已死，由恢复扫描回收。
 */
export const DISPATCH_CLAIM_LEASE_MS = 30 * 60_000

/** 同一意图最多被 claim 几次；超过即判 failed，交人工/恢复。 */
export const DISPATCH_MAX_ATTEMPTS = 3

interface DispatchRow {
  id: string
  goal_id: string
  task_id: string
  subtask_id: string
  target: string
  agent_id: string | null
  objective: string
  idempotency_key: string
  execution_id: string | null
  payload: string | null
  status: string
  attempts: number
  created_at: string
  claimed_at: string | null
  claimed_by: string | null
  claim_token: string | null
  finished_at: string | null
  error: string | null
}

function toIntent(row: DispatchRow): DispatchIntent {
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
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    target: row.target as DispatchTarget,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    objective: row.objective,
    idempotencyKey: row.idempotency_key,
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(payload === undefined ? {} : { payload }),
    status: row.status as DispatchStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.error === null ? {} : { error: row.error }),
  }
}

export interface EnqueueDispatchInput {
  goalId: string
  taskId: string
  subtaskId: string
  target: DispatchTarget
  agentId?: string
  objective: string
  idempotencyKey: string
  /** 显式 executionId；缺省由调度器按 idempotencyKey 派生。 */
  executionId?: string
  /** 可独立执行所需的可序列化规格（见 DispatchIntent.payload）。 */
  payload?: unknown
}

/**
 * 先落库再执行：同一 `idempotencyKey` 只会有一行。
 * `created=false` 表示这条意图早就派过（重放/重启），调用方不得重复执行。
 */
export function enqueueDispatch(
  db: Db,
  input: EnqueueDispatchInput,
): { intent: DispatchIntent; created: boolean } {
  const id = newId()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO dispatch_queue (
         id, goal_id, task_id, subtask_id, target, agent_id, objective,
         idempotency_key, execution_id, payload, status, created_at
       ) VALUES (
         @id, @goalId, @taskId, @subtaskId, @target, @agentId, @objective,
         @idempotencyKey, @executionId, @payload, 'pending', @createdAt
       )`,
    )
    .run({
      id,
      goalId: input.goalId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      target: input.target,
      agentId: input.agentId ?? null,
      objective: input.objective,
      idempotencyKey: input.idempotencyKey,
      executionId: input.executionId ?? null,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      createdAt: new Date().toISOString(),
    })

  const row = db
    .prepare('SELECT * FROM dispatch_queue WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as DispatchRow | undefined
  if (row === undefined) {
    throw new HubError('DB_UNAVAILABLE', `派发意图写入后读不到：${input.idempotencyKey}`)
  }
  return { intent: toIntent(row), created: result.changes > 0 }
}

export interface ClaimDispatchInput {
  /** 只领该 Goal 的意图；缺省为全局（供调度器/恢复用）。 */
  goalId?: string
  /** 只领这一条（调用方刚入队、不想被旧意图抢占时用）。 */
  intentId?: string
  claimedBy: string
  now?: Date
  maxAttempts?: number
}

/**
 * 领一条待执行意图，生成新的 `claimToken`。
 * 与决策点队列一样：这里不做过期回收，回收是调度器的职责。
 */
export function claimDispatch(db: Db, input: ClaimDispatchInput): DispatchIntent | undefined {
  const now = input.now ?? new Date()
  const maxAttempts = input.maxAttempts ?? DISPATCH_MAX_ATTEMPTS
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    throw new HubError('CONFIG_INVALID', 'maxAttempts 必须为正数', { maxAttempts })
  }
  const scoped = input.goalId !== undefined
  const targeted = input.intentId !== undefined
  const where = [
    "status = 'pending'",
    ...(scoped ? ['goal_id = @goalId'] : []),
    ...(targeted ? ['id = @intentId'] : []),
  ].join(' AND ')
  const params: Record<string, unknown> = {
    ...(scoped ? { goalId: input.goalId } : {}),
    ...(targeted ? { intentId: input.intentId } : {}),
  }

  return db.transaction((): DispatchIntent | undefined => {
    const rows = db
      .prepare(
        `SELECT * FROM dispatch_queue WHERE ${where}
         ORDER BY created_at ASC, id ASC LIMIT 50`,
      )
      .all(params) as DispatchRow[]

    for (const row of rows) {
      if (row.attempts >= maxAttempts) {
        db.prepare(
          `UPDATE dispatch_queue
           SET status = 'failed', finished_at = ?, error = 'claim attempts exhausted'
           WHERE id = ? AND status = 'pending'`,
        ).run(now.toISOString(), row.id)
        continue
      }

      const token = newId()
      const info = db
        .prepare(
          `UPDATE dispatch_queue
           SET status = 'claimed', claimed_at = ?, claimed_by = ?, claim_token = ?,
               attempts = attempts + 1
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now.toISOString(), input.claimedBy, token, row.id)
      if (info.changes === 0) continue

      const claimed = db
        .prepare('SELECT * FROM dispatch_queue WHERE id = ?')
        .get(row.id) as DispatchRow
      return toIntent(claimed)
    }
    return undefined
  })()
}

/**
 * 退回 pending：用于“发现已有在途执行”等不该收尾的情况。
 * 保留 `attempts`，避免无限退回；`error` 保留原因供排查。
 */
export function releaseDispatch(
  db: Db,
  id: string,
  options: { claimToken: string; error?: string; now?: Date },
): boolean {
  const info = db
    .prepare(
      `UPDATE dispatch_queue
       SET status = 'pending', claimed_at = NULL, claimed_by = NULL, claim_token = NULL, error = ?
       WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(options.error ?? null, id, options.claimToken)
  return info.changes > 0
}

/** 收尾：必须匹配 `id + claimToken + status = 'claimed'`。 */
export function completeDispatch(
  db: Db,
  id: string,
  options: {
    claimToken: string
    status: Extract<DispatchStatus, 'done' | 'failed'>
    error?: string
    now?: Date
  },
): boolean {
  const info = db
    .prepare(
      `UPDATE dispatch_queue
       SET status = ?, finished_at = ?, error = ?
       WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    )
    .run(
      options.status,
      (options.now ?? new Date()).toISOString(),
      options.error ?? null,
      id,
      options.claimToken,
    )
  return info.changes > 0
}

export interface ReclaimDispatchesOptions {
  goalId?: string
  now?: Date
  leaseMs?: number
}

/** 回收过期 claim，退回 pending 等调度器重领；保留 attempts 以便封顶。 */
export function reclaimExpiredDispatches(db: Db, options: ReclaimDispatchesOptions = {}): string[] {
  const leaseMs = options.leaseMs ?? DISPATCH_CLAIM_LEASE_MS
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new HubError('CONFIG_INVALID', 'dispatch claim lease 必须为正数', { leaseMs })
  }
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - leaseMs).toISOString()
  const scoped = options.goalId !== undefined
  const where = scoped
    ? `status = 'claimed' AND claim_token IS NOT NULL AND claimed_at <= @cutoff AND goal_id = @goalId`
    : `status = 'claimed' AND claim_token IS NOT NULL AND claimed_at <= @cutoff`
  const params = scoped ? { cutoff, goalId: options.goalId } : { cutoff }

  return db.transaction(() => {
    const expired = db
      .prepare(`SELECT id FROM dispatch_queue WHERE ${where} ORDER BY created_at ASC, id ASC`)
      .all(params) as Array<{ id: string }>
    if (expired.length === 0) return []

    db.prepare(
      `UPDATE dispatch_queue
       SET status = 'pending', claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
           error = 'claim lease expired'
       WHERE ${where}`,
    ).run(params)

    return expired.map((row) => row.id)
  })()
}

export function listDispatches(db: Db, goalId: string): DispatchIntent[] {
  const rows = db
    .prepare('SELECT * FROM dispatch_queue WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
    .all(goalId) as DispatchRow[]
  return rows.map(toIntent)
}
