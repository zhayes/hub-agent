import { isTerminalRemoteState, type RemoteObservedState } from '../domain/status'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

/**
 * 远端任务关联与对账（PRD §7.6.4 / PLAN-A2A §4.1.1）。
 *
 * 这一层只负责“我和远端哪个任务是同一个”的事实记录：
 * - `idempotencyKey` 唯一 → 重放不可能发第二次委托；
 * - `(peerId, remoteTaskId)` 唯一 → 一个远端任务只对应一条本地关联；
 * - `observedState` **只由远端读取写入**，本地不得推断。
 *
 * 它**不是**本地状态机：本地 Execution 是否成功仍由验收决定（ADR 0007）。
 */
export interface RemoteTaskRef {
  id: string
  goalId: string
  /** 发起这单委托的本地 Task / Subtask；对账时用来自愈式建 Execution。 */
  taskId?: string
  subtaskId?: string
  /** 建立本地 Execution 后回填；提交阶段可空。 */
  localExecutionId?: string
  peerId: string
  idempotencyKey: string
  remoteTaskId: string
  contextId: string
  messageId: string
  observedState: RemoteObservedState
  eventCursor?: string
  createdAt: string
  lastSeenAt: string
  /** 非空表示已停止对账（远端已无此任务或本地已放弃）；不代表成功。 */
  closedAt?: string
}

interface RemoteTaskRefRow {
  id: string
  goal_id: string
  task_id: string | null
  subtask_id: string | null
  local_execution_id: string | null
  peer_id: string
  idempotency_key: string
  remote_task_id: string
  context_id: string
  message_id: string
  observed_state: string
  event_cursor: string | null
  created_at: string
  last_seen_at: string
  closed_at: string | null
}

function toRef(row: RemoteTaskRefRow): RemoteTaskRef {
  return {
    id: row.id,
    goalId: row.goal_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.subtask_id === null ? {} : { subtaskId: row.subtask_id }),
    ...(row.local_execution_id === null ? {} : { localExecutionId: row.local_execution_id }),
    peerId: row.peer_id,
    idempotencyKey: row.idempotency_key,
    remoteTaskId: row.remote_task_id,
    contextId: row.context_id,
    messageId: row.message_id,
    observedState: row.observed_state as RemoteObservedState,
    ...(row.event_cursor === null ? {} : { eventCursor: row.event_cursor }),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  }
}

export interface RememberRemoteTaskInput {
  goalId: string
  taskId?: string
  subtaskId?: string
  peerId: string
  idempotencyKey: string
  remoteTaskId: string
  contextId: string
  messageId: string
  observedState: RemoteObservedState
  eventCursor?: string
  now?: Date
}

/**
 * 记录一次远端派发的结果。`created=false` 表示同一幂等键早已记过：
 * 调用方**不得**再发第二次委托，直接当成功重放处理。
 *
 * 两种唯一约束撞法要分开：
 * - 撞 `idempotency_key`：正常重放，返回已有行；
 * - 撞 `(peer_id, remote_task_id)` 却是另一个幂等键：异常（远端把两个请求当成同一任务），
 *   抛 `EVENT_REJECTED` 暴露出来，不静默吞掉。
 */
export function rememberRemoteTask(
  db: Db,
  input: RememberRemoteTaskInput,
): { ref: RemoteTaskRef; created: boolean } {
  const id = newId()
  const now = (input.now ?? new Date()).toISOString()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO remote_task_refs (
         id, goal_id, task_id, subtask_id, peer_id, idempotency_key, remote_task_id,
         context_id, message_id, observed_state, event_cursor, created_at, last_seen_at
       ) VALUES (
         @id, @goalId, @taskId, @subtaskId, @peerId, @idempotencyKey, @remoteTaskId,
         @contextId, @messageId, @observedState, @eventCursor, @createdAt, @lastSeenAt
       )`,
    )
    .run({
      id,
      goalId: input.goalId,
      taskId: input.taskId ?? null,
      subtaskId: input.subtaskId ?? null,
      peerId: input.peerId,
      idempotencyKey: input.idempotencyKey,
      remoteTaskId: input.remoteTaskId,
      contextId: input.contextId,
      messageId: input.messageId,
      observedState: input.observedState,
      eventCursor: input.eventCursor ?? null,
      createdAt: now,
      lastSeenAt: now,
    })

  const byKey = findRemoteTaskByIdempotencyKey(db, input.idempotencyKey)
  if (byKey !== undefined) return { ref: byKey, created: result.changes > 0 }

  /* 插入被忽略但幂等键查不到：只能是 (peer_id, remote_task_id) 撞了另一条。 */
  const byRemote = findRemoteTaskByRemoteId(db, input.peerId, input.remoteTaskId)
  if (byRemote !== undefined) {
    throw new HubError('EVENT_REJECTED', '远端任务已关联到另一个幂等键', {
      peerId: input.peerId,
      remoteTaskId: input.remoteTaskId,
      existingKey: byRemote.idempotencyKey,
      incomingKey: input.idempotencyKey,
    })
  }
  throw new HubError('DB_UNAVAILABLE', `远端任务关联写入后读不到：${input.idempotencyKey}`)
}

export function findRemoteTaskByIdempotencyKey(
  db: Db,
  idempotencyKey: string,
): RemoteTaskRef | undefined {
  const row = db
    .prepare('SELECT * FROM remote_task_refs WHERE idempotency_key = ?')
    .get(idempotencyKey) as RemoteTaskRefRow | undefined
  return row === undefined ? undefined : toRef(row)
}

export function findRemoteTaskById(db: Db, id: string): RemoteTaskRef | undefined {
  const row = db.prepare('SELECT * FROM remote_task_refs WHERE id = ?').get(id) as
    | RemoteTaskRefRow
    | undefined
  return row === undefined ? undefined : toRef(row)
}

export function findRemoteTaskByRemoteId(
  db: Db,
  peerId: string,
  remoteTaskId: string,
): RemoteTaskRef | undefined {
  const row = db
    .prepare('SELECT * FROM remote_task_refs WHERE peer_id = ? AND remote_task_id = ?')
    .get(peerId, remoteTaskId) as RemoteTaskRefRow | undefined
  return row === undefined ? undefined : toRef(row)
}

export function listRemoteTasks(db: Db, goalId: string): RemoteTaskRef[] {
  const rows = db
    .prepare('SELECT * FROM remote_task_refs WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
    .all(goalId) as RemoteTaskRefRow[]
  return rows.map(toRef)
}

/**
 * 汇总一次远端观测。**只写观测值**，不改本地状态机。
 *
 * `eventCursor` 缺省时保留原值（不会把已知游标清空）；`lastSeenAt` 每次刷新，
 * 用于判断“这条关联多久没对过账了”。
 */
export function observeRemoteTask(
  db: Db,
  input: {
    id: string
    observedState: RemoteObservedState
    eventCursor?: string
    now?: Date
  },
): boolean {
  const now = (input.now ?? new Date()).toISOString()
  const info =
    input.eventCursor === undefined
      ? db
          .prepare(`UPDATE remote_task_refs SET observed_state = ?, last_seen_at = ? WHERE id = ?`)
          .run(input.observedState, now, input.id)
      : db
          .prepare(
            `UPDATE remote_task_refs
             SET observed_state = ?, event_cursor = ?, last_seen_at = ?
             WHERE id = ?`,
          )
          .run(input.observedState, input.eventCursor, now, input.id)
  return info.changes > 0
}

/** 建立本地 Execution 后回填关联；`local_execution_id` 的 UNIQUE 会拦住重复绑定。 */
export function attachLocalExecution(
  db: Db,
  input: { id: string; localExecutionId: string },
): boolean {
  const info = db
    .prepare(
      `UPDATE remote_task_refs SET local_execution_id = ?
       WHERE id = ? AND local_execution_id IS NULL`,
    )
    .run(input.localExecutionId, input.id)
  return info.changes > 0
}

export interface CloseRemoteTaskInput {
  id: string
  /** 关单时一并记录的观测值（如 `unknown`）；缺省保留原值。 */
  observedState?: RemoteObservedState
  now?: Date
}

/**
 * 停止对账：远端已无该任务（`TaskNotFound`）或本地已放弃这个委托。
 *
 * **关单不是成功**：它只表示不会再有下一轮轮询，结论仍看 `observed_state` 与本地验收。
 * 重复调用幂等（已关单则返回 false）。
 */
export function closeRemoteTask(db: Db, input: CloseRemoteTaskInput): boolean {
  const now = (input.now ?? new Date()).toISOString()
  const info =
    input.observedState === undefined
      ? db
          .prepare(
            `UPDATE remote_task_refs SET closed_at = ?, last_seen_at = ?
             WHERE id = ? AND closed_at IS NULL`,
          )
          .run(now, now, input.id)
      : db
          .prepare(
            `UPDATE remote_task_refs SET closed_at = ?, last_seen_at = ?, observed_state = ?
             WHERE id = ? AND closed_at IS NULL`,
          )
          .run(now, now, input.observedState, input.id)
  return info.changes > 0
}

export interface ListNeedingPollOptions {
  now?: Date
  /** 只取“这么久没刷新过”的（避免每 tick 都打所有人）；缺省不限制。 */
  staleAfterMs?: number
  limit?: number
}

/**
 * 找需要继续对账的远端任务：非终态，最久没刷新的优先。
 *
 * 断线/重启后它就是恢复依据——不依赖内存里那个已经不存在的调用栈。
 */
export function listRemoteTasksNeedingPoll(
  db: Db,
  options: ListNeedingPollOptions = {},
): RemoteTaskRef[] {
  const limit = options.limit ?? 50
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new HubError('CONFIG_INVALID', 'limit 必须为正数', { limit })
  }
  const placeholders = ['completed', 'failed', 'canceled', 'rejected'].map(() => '?').join(', ')

  const rows =
    options.staleAfterMs === undefined
      ? (db
          .prepare(
            `SELECT * FROM remote_task_refs
             WHERE closed_at IS NULL AND observed_state NOT IN (${placeholders})
             ORDER BY last_seen_at ASC, id ASC LIMIT ?`,
          )
          .all('completed', 'failed', 'canceled', 'rejected', limit) as RemoteTaskRefRow[])
      : (db
          .prepare(
            `SELECT * FROM remote_task_refs
             WHERE closed_at IS NULL AND observed_state NOT IN (${placeholders})
               AND last_seen_at <= ?
             ORDER BY last_seen_at ASC, id ASC LIMIT ?`,
          )
          .all(
            'completed',
            'failed',
            'canceled',
            'rejected',
            new Date((options.now ?? new Date()).getTime() - options.staleAfterMs).toISOString(),
            limit,
          ) as RemoteTaskRefRow[])

  return rows.map(toRef)
}

/** 判断某条关联是否已到远端终态（供对账产出决策点时用）。 */
export function isRemoteTaskTerminal(ref: RemoteTaskRef): boolean {
  return isTerminalRemoteState(ref.observedState)
}
