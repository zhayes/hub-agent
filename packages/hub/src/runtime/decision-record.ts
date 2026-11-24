import type { DecisionRecord, DecisionRecordType } from '../brain/types'
import { asTimestamp } from '../domain/ids'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

interface DecisionRow {
  id: string
  goal_id: string
  plan_revision: number | null
  type: string
  rationale: string
  inputs: string
  alternatives: string | null
  decided_at: string
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    ...(row.plan_revision === null ? {} : { planRevision: row.plan_revision }),
    type: row.type as DecisionRecordType,
    rationale: row.rationale,
    inputs: parseJson<Record<string, unknown>>(row.inputs, {}),
    ...(row.alternatives === null
      ? {}
      : { alternatives: parseJson<string[]>(row.alternatives, []) }),
    decidedAt: row.decided_at,
  }
}

export interface RecordDecisionInput {
  goalId: string
  planRevision?: number
  type: DecisionRecordType
  rationale: string
  inputs: Record<string, unknown>
  alternatives?: string[]
}

export function recordDecision(db: Db, input: RecordDecisionInput): DecisionRecord {
  const id = newId()
  const decidedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO decision_records (
       id, goal_id, plan_revision, type, rationale, inputs, alternatives, decided_at
     ) VALUES (@id, @goalId, @planRevision, @type, @rationale, @inputs, @alternatives, @decidedAt)`,
  ).run({
    id,
    goalId: input.goalId,
    planRevision: input.planRevision ?? null,
    type: input.type,
    rationale: input.rationale,
    inputs: JSON.stringify(input.inputs),
    alternatives: input.alternatives === undefined ? null : JSON.stringify(input.alternatives),
    decidedAt,
  })
  return {
    id,
    goalId: input.goalId,
    ...(input.planRevision === undefined ? {} : { planRevision: input.planRevision }),
    type: input.type,
    rationale: input.rationale,
    inputs: input.inputs,
    ...(input.alternatives === undefined ? {} : { alternatives: input.alternatives }),
    decidedAt: asTimestamp(decidedAt),
  }
}

export function listDecisions(db: Db, goalId: string): DecisionRecord[] {
  const rows = db
    .prepare('SELECT * FROM decision_records WHERE goal_id = ? ORDER BY decided_at ASC, id ASC')
    .all(goalId) as DecisionRow[]
  return rows.map(toRecord)
}
