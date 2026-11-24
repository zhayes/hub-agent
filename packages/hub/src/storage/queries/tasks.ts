import type { Db } from '../db'

export interface TaskListRow {
  id: string
  goalId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export function listTasks(db: Db, limit = 50): TaskListRow[] {
  const rows = db
    .prepare(
      `SELECT id, goal_id, title, status, created_at, updated_at
       FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string
    goal_id: string
    title: string
    status: string
    created_at: string
    updated_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export interface TaskEventRow {
  seq: number
  type: string
  aggregateType: string
  aggregateId: string
  at: string
  actor: string
  payload: unknown
}

export function listTaskEvents(db: Db, taskId: string): TaskEventRow[] {
  const task = db.prepare('SELECT goal_id FROM tasks WHERE id = ?').get(taskId) as
    | { goal_id: string }
    | undefined
  if (task === undefined) return []
  const rows = db
    .prepare(
      `SELECT seq, type, aggregate_type, aggregate_id, at, actor, payload
       FROM events WHERE goal_id = ? ORDER BY seq ASC`,
    )
    .all(task.goal_id) as Array<{
    seq: number
    type: string
    aggregate_type: string
    aggregate_id: string
    at: string
    actor: string
    payload: string
  }>
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    at: row.at,
    actor: row.actor,
    payload: safeParse(row.payload),
  }))
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
