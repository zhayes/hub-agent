import type { Db } from '../db'

export interface EventView {
  seq: number
  id: string
  type: string
  aggregateType: string
  aggregateId: string
  goalId?: string
  at: string
  actor: string
  payload: unknown
  traceId?: string
}

interface EventRow {
  seq: number
  id: string
  type: string
  aggregate_type: string
  aggregate_id: string
  goal_id: string | null
  at: string
  actor: string
  payload: string
  trace_id: string | null
}

function toEvent(row: EventRow): EventView {
  let payload: unknown = row.payload
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // keep raw
  }
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    ...(row.goal_id === null ? {} : { goalId: row.goal_id }),
    at: row.at,
    actor: row.actor,
    payload,
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
  }
}

export function listEventsSince(db: Db, sinceSeq: number, limit = 100): EventView[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(sinceSeq, limit) as EventRow[]
  return rows.map(toEvent)
}
