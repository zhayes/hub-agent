import type { ChatMessage, ChatMessageKind, ChatRole, ChatThread } from '../../domain/chat'
import {
  asChatMessageId,
  asChatThreadId,
  asGoalId,
  asTaskId,
  asTimestamp,
  type ChatThreadId,
} from '../../domain/ids'
import { newId } from '../../shared/id'
import type { Db } from '../db'

interface ThreadRow {
  id: string
  title: string
  goal_id: string | null
  task_id: string | null
  status: string
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
    createdAt: asTimestamp(row.created_at),
  }
}

export function createChatThread(
  db: Db,
  input: { title: string; goalId?: string; taskId?: string },
): ChatThread {
  const now = asTimestamp(new Date().toISOString())
  const id = asChatThreadId(newId())
  db.prepare(
    `INSERT INTO chat_threads (id, title, goal_id, task_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, input.title, input.goalId ?? null, input.taskId ?? null, now, now)
  return {
    id,
    title: input.title,
    ...(input.goalId === undefined ? {} : { goalId: asGoalId(input.goalId) }),
    ...(input.taskId === undefined ? {} : { taskId: asTaskId(input.taskId) }),
    status: 'active',
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
  },
): void {
  const current = getChatThread(db, id)
  if (current === undefined) return
  const now = asTimestamp(new Date().toISOString())
  db.prepare(
    `UPDATE chat_threads
     SET title = ?, goal_id = ?, task_id = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? current.title,
    patch.goalId ?? current.goalId ?? null,
    patch.taskId ?? current.taskId ?? null,
    patch.status ?? current.status,
    now,
    id,
  )
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

export function listChatMessages(db: Db, threadId: ChatThreadId, limit = 100): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(threadId, limit) as MessageRow[]
  return rows.map(toMessage)
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
  },
): ChatMessage {
  const now = asTimestamp(new Date().toISOString())
  const id = asChatMessageId(newId())
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, role, kind, content, goal_id, task_id, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.threadId,
      input.role,
      input.kind,
      input.content,
      input.goalId ?? null,
      input.taskId ?? null,
      input.approvalId ?? null,
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
    createdAt: now,
  }
}
