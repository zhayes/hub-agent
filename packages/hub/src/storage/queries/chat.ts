import {
  type ChatMessage,
  type ChatMessageKind,
  type ChatRole,
  type ChatRunSettings,
  type ChatThread,
  DEFAULT_RUN_SETTINGS,
  parseRunSettings,
  serializeRunSettings,
} from '../../domain/chat'
import {
  asChatMessageId,
  asChatThreadId,
  asGoalId,
  asTaskId,
  asTimestamp,
  type ChatMessageId,
  type ChatThreadId,
} from '../../domain/ids'
import { isPermissionMode, type PermissionMode } from '../../domain/status'
import { newId } from '../../shared/id'
import type { Db } from '../db'

interface ThreadRow {
  id: string
  title: string
  goal_id: string | null
  task_id: string | null
  status: string
  worktree: string | null
  permission_mode: string
  run_settings: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  thread_id: string
  role: string
  kind: string
  content: string
  goal_id: string | null
  task_id: string | null
  approval_id: string | null
  clarification_id: string | null
  agent_name: string | null
  stage: string | null
  detail: string | null
  updated_at: string | null
  created_at: string
}

export interface ChatThreadSummary extends ChatThread {
  messageCount: number
  lastMessage?: string
}

function toThread(row: ThreadRow): ChatThread {
  return {
    id: asChatThreadId(row.id),
    title: row.title,
    ...(row.goal_id === null ? {} : { goalId: asGoalId(row.goal_id) }),
    ...(row.task_id === null ? {} : { taskId: asTaskId(row.task_id) }),
    status: row.status as ChatThread['status'],
    ...(row.worktree === null ? {} : { worktree: row.worktree }),
    permissionMode: isPermissionMode(row.permission_mode) ? row.permission_mode : 'workspace-write',
    runSettings: parseRunSettings(row.run_settings),
    ...(row.archived_at === null ? {} : { archivedAt: asTimestamp(row.archived_at) }),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
  }
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: asChatMessageId(row.id),
    threadId: asChatThreadId(row.thread_id),
    role: row.role as ChatRole,
    kind: row.kind as ChatMessageKind,
    content: row.content,
    ...(row.goal_id === null ? {} : { goalId: asGoalId(row.goal_id) }),
    ...(row.task_id === null ? {} : { taskId: asTaskId(row.task_id) }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    ...(row.clarification_id === null ? {} : { clarificationId: row.clarification_id }),
    ...(row.agent_name === null ? {} : { agentName: row.agent_name }),
    ...(row.stage === null ? {} : { stage: row.stage as ChatMessage['stage'] }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    updatedAt: asTimestamp(row.updated_at ?? row.created_at),
    createdAt: asTimestamp(row.created_at),
  }
}

export function createChatThread(
  db: Db,
  input: {
    title: string
    goalId?: string
    taskId?: string
    worktree?: string
    permissionMode?: PermissionMode
    runSettings?: ChatRunSettings
  },
): ChatThread {
  const now = asTimestamp(new Date().toISOString())
  const id = asChatThreadId(newId())
  const permissionMode: PermissionMode = input.permissionMode ?? 'workspace-write'
  const runSettings = input.runSettings ?? DEFAULT_RUN_SETTINGS
  db.prepare(
    `INSERT INTO chat_threads (id, title, goal_id, task_id, status, worktree, permission_mode, run_settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    input.goalId ?? null,
    input.taskId ?? null,
    input.worktree ?? null,
    permissionMode,
    serializeRunSettings(runSettings),
    now,
    now,
  )
  return {
    id,
    title: input.title,
    ...(input.goalId === undefined ? {} : { goalId: asGoalId(input.goalId) }),
    ...(input.taskId === undefined ? {} : { taskId: asTaskId(input.taskId) }),
    status: 'idle',
    ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    permissionMode,
    runSettings,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateChatThread(
  db: Db,
  id: ChatThreadId,
  patch: {
    title?: string
    goalId?: string
    taskId?: string
    status?: ChatThread['status']
    worktree?: string
    permissionMode?: PermissionMode
    runSettings?: ChatRunSettings
    /** 传 null 表示取消归档。 */
    archivedAt?: string | null
  },
): void {
  const current = getChatThread(db, id)
  if (current === undefined) return
  const now = asTimestamp(new Date().toISOString())
  db.prepare(
    `UPDATE chat_threads
     SET title = ?, goal_id = ?, task_id = ?, status = ?, worktree = ?, permission_mode = ?, run_settings = ?, archived_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? current.title,
    patch.goalId ?? current.goalId ?? null,
    patch.taskId ?? current.taskId ?? null,
    patch.status ?? current.status,
    patch.worktree ?? current.worktree ?? null,
    patch.permissionMode ?? current.permissionMode,
    serializeRunSettings(patch.runSettings ?? current.runSettings),
    patch.archivedAt === undefined ? (current.archivedAt ?? null) : patch.archivedAt,
    now,
    id,
  )
}

export function deleteChatThread(db: Db, id: ChatThreadId): boolean {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(id)
    return db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id).changes > 0
  })
  return write()
}

/** 消息原地更新：流式思考/工具状态用；不改变 thread 的排序时间。 */
export function updateChatMessage(
  db: Db,
  id: ChatMessageId,
  patch: {
    content?: string
    stage?: ChatMessage['stage']
    kind?: ChatMessage['kind']
    detail?: string
  },
): ChatMessage | undefined {
  const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined
  if (row === undefined) return undefined
  const now = new Date().toISOString()
  const content = patch.content ?? row.content
  const stage = patch.stage ?? row.stage
  const kind = patch.kind ?? row.kind
  const detail = patch.detail ?? row.detail
  db.prepare(
    'UPDATE chat_messages SET content = ?, stage = ?, kind = ?, detail = ?, updated_at = ? WHERE id = ?',
  ).run(content, stage, kind, detail, now, id)
  return toMessage({ ...row, content, stage, kind, detail, updated_at: now })
}

/** 当前 thread 已写入的最大 updated_at：SSE 重连时从这里续传更新帧。 */
export function maxChatUpdatedAt(db: Db, threadId: ChatThreadId): string | undefined {
  const row = db
    .prepare('SELECT MAX(updated_at) AS value FROM chat_messages WHERE thread_id = ?')
    .get(threadId) as { value: string | null }
  return row.value ?? undefined
}

/** SSE 增量更新：只取 updated_at 严格大于水位线的消息。 */
export function listChatMessagesUpdatedAfter(
  db: Db,
  threadId: ChatThreadId,
  after: string,
  limit = 100,
): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE thread_id = ? AND updated_at > ?
       ORDER BY updated_at ASC, rowid ASC LIMIT ?`,
    )
    .all(threadId, after, limit) as MessageRow[]
  return rows.map(toMessage)
}

export function getChatThread(db: Db, id: ChatThreadId): ChatThread | undefined {
  const row = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id) as ThreadRow | undefined
  return row === undefined ? undefined : toThread(row)
}

export function listChatThreads(db: Db, limit = 50): ChatThreadSummary[] {
  const rows = db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count,
        (SELECT m.content FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
       FROM chat_threads t
       WHERE t.archived_at IS NULL
       ORDER BY t.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<ThreadRow & { message_count: number; last_message: string | null }>
  return rows.map((row) => ({
    ...toThread(row),
    messageCount: row.message_count,
    ...(row.last_message === null ? {} : { lastMessage: row.last_message }),
  }))
}

export interface ChatMessagePage {
  limit?: number
  /** 只取该时间之前的消息；配合“加载更早”使用 */
  before?: string
}

export function listChatMessages(
  db: Db,
  threadId: ChatThreadId,
  page: number | ChatMessagePage = {},
): ChatMessage[] {
  const limit = typeof page === 'number' ? page : (page.limit ?? 100)
  const before = typeof page === 'number' ? undefined : page.before
  const rows = (
    before === undefined
      ? db
          .prepare(
            `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(threadId, limit)
      : db
          .prepare(
            `SELECT * FROM chat_messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(threadId, before, limit)
  ) as MessageRow[]
  return rows.reverse().map(toMessage)
}

export interface ChatMessageCursor {
  /** Monotonic insert order (SQLite rowid), not the ULID: ULIDs are not
      monotonic within the same millisecond, so they cannot order a stream. */
  seq: number
}

/** Ascending page used by the chat stream: everything after `after.seq`. */
export function listChatMessagesAfter(
  db: Db,
  threadId: ChatThreadId,
  afterSeq: number | undefined,
  limit = 100,
): Array<{ seq: number; message: ChatMessage }> {
  const rows = (
    afterSeq === undefined
      ? db
          .prepare(
            `SELECT rowid AS seq, * FROM chat_messages WHERE thread_id = ? ORDER BY rowid ASC LIMIT ?`,
          )
          .all(threadId, limit)
      : db
          .prepare(
            `SELECT rowid AS seq, * FROM chat_messages
             WHERE thread_id = ? AND rowid > ?
             ORDER BY rowid ASC LIMIT ?`,
          )
          .all(threadId, afterSeq, limit)
  ) as Array<MessageRow & { seq: number }>
  return rows.map((row) => ({ seq: row.seq, message: toMessage(row) }))
}

export function appendChatMessage(
  db: Db,
  input: {
    threadId: ChatThreadId
    role: ChatRole
    kind: ChatMessageKind
    content: string
    goalId?: string
    taskId?: string
    approvalId?: string
    clarificationId?: string
    agentName?: string
    stage?: ChatMessage['stage']
    detail?: string
  },
): ChatMessage {
  const now = asTimestamp(new Date().toISOString())
  const id = asChatMessageId(newId())
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, role, kind, content, goal_id, task_id, approval_id, clarification_id, agent_name, stage, detail, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.threadId,
      input.role,
      input.kind,
      input.content,
      input.goalId ?? null,
      input.taskId ?? null,
      input.approvalId ?? null,
      input.clarificationId ?? null,
      input.agentName ?? null,
      input.stage ?? null,
      input.detail ?? null,
      now,
      now,
    )
    db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, input.threadId)
  })
  write()
  return {
    id,
    threadId: input.threadId,
    role: input.role,
    kind: input.kind,
    content: input.content,
    ...(input.goalId === undefined ? {} : { goalId: asGoalId(input.goalId) }),
    ...(input.taskId === undefined ? {} : { taskId: asTaskId(input.taskId) }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.clarificationId === undefined ? {} : { clarificationId: input.clarificationId }),
    ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    updatedAt: now,
    createdAt: now,
  }
}
