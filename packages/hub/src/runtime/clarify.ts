import type { Clarification } from '../brain/types'
import { asTimestamp } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { applyClarificationAnswer } from './acceptance'

interface ClarificationRow {
  id: string
  goal_id: string
  kind: string
  execution_id: string | null
  question: string
  options: string | null
  status: string
  answer: string | null
  answered_by: string | null
  created_at: string
  expires_at: string
  answered_at: string | null
}

function parseOptions(value: string | null): string[] {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function toClarification(row: ClarificationRow): Clarification {
  return {
    id: row.id,
    goalId: row.goal_id,
    kind: row.kind as 'clarify' | 'decide',
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    question: row.question,
    options: parseOptions(row.options),
    status: row.status as Clarification['status'],
    ...(row.answer === null ? {} : { answer: row.answer }),
    ...(row.answered_by === null ? {} : { answeredBy: 'human' }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
  }
}

export interface CreateClarificationInput {
  goalId: string
  kind?: 'clarify' | 'decide'
  executionId?: string
  question: string
  options?: string[]
  ttlMs?: number
}

const DEFAULT_TTL_MS = 60 * 60_000

export function createClarification(db: Db, input: CreateClarificationInput): Clarification {
  const question = input.question.trim()
  if (question.length === 0) {
    throw new HubError('CONFIG_INVALID', '澄清问题不能为空')
  }
  const kind = input.kind ?? 'clarify'
  if (kind === 'clarify' && input.executionId === undefined) {
    throw new HubError('CONFIG_INVALID', 'clarify 必须携带 executionId')
  }
  const id = newId()
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString()
  db.prepare(
    `INSERT INTO clarifications (
       id, goal_id, kind, execution_id, question, options, status, answer, answered_by,
       created_at, expires_at, answered_at
     ) VALUES (
       @id, @goalId, @kind, @executionId, @question, @options, 'pending', NULL, NULL,
       @createdAt, @expiresAt, NULL
     )`,
  ).run({
    id,
    goalId: input.goalId,
    kind,
    executionId: input.executionId ?? null,
    question,
    options: JSON.stringify(input.options ?? []),
    createdAt,
    expiresAt,
  })
  return {
    id,
    goalId: input.goalId,
    kind,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    question,
    options: input.options ?? [],
    status: 'pending',
    createdAt,
    expiresAt,
  }
}

/**
 * 答案按 questionId + executionId 路由（PRD §13.5.6）。
 * 两个并行问题的答案不能串：executionId 必须精确匹配，包括“都没有”的情况。
 */
export function answerClarification(
  db: Db,
  input: { questionId: string; executionId?: string; answer: string },
): Clarification {
  const row = db.prepare('SELECT * FROM clarifications WHERE id = ?').get(input.questionId) as
    | ClarificationRow
    | undefined
  if (row === undefined) {
    throw new HubError('NOT_FOUND', `澄清问题不存在：${input.questionId}`, {
      questionId: input.questionId,
    })
  }
  if (row.status !== 'pending') {
    throw new HubError('EVENT_REJECTED', `澄清问题已不是 pending：${row.status}`, {
      questionId: input.questionId,
    })
  }
  const expectedExecution = row.execution_id ?? undefined
  if (expectedExecution !== input.executionId) {
    throw new HubError('EVENT_REJECTED', '答案的 executionId 与问题不匹配，拒绝路由', {
      questionId: input.questionId,
      expectedExecution,
      receivedExecution: input.executionId,
    })
  }
  const answer = input.answer.trim()
  if (answer.length === 0) {
    throw new HubError('CONFIG_INVALID', '答案不能为空')
  }
  const options = parseOptions(row.options)
  if (options.length > 0 && !options.includes(answer)) {
    throw new HubError('EVENT_REJECTED', '答案不在问题的选项中', {
      questionId: input.questionId,
      options,
    })
  }
  const answeredAt = new Date().toISOString()
  db.prepare(
    `UPDATE clarifications
     SET status = 'answered', answer = ?, answered_by = 'human', answered_at = ?
     WHERE id = ?`,
  ).run(input.answer, answeredAt, input.questionId)

  /* 如果这是人工验收闸门（选项 accept/reject + 执行在 waiting_input），答案就是决定：
     直接收敛状态并唤醒 Brain；不合闸门则什么都不做。 */
  applyClarificationAnswer(db, {
    ...(expectedExecution === undefined ? {} : { executionId: expectedExecution }),
    options,
    answer,
  })
  return {
    ...toClarification(row),
    status: 'answered',
    answer: input.answer,
    answeredBy: 'human',
    answeredAt: asTimestamp(answeredAt),
  }
}

export function listClarifications(db: Db, goalId: string): Clarification[] {
  const rows = db
    .prepare('SELECT * FROM clarifications WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
    .all(goalId) as ClarificationRow[]
  return rows.map(toClarification)
}

export function getClarification(db: Db, id: string): Clarification | undefined {
  const row = db.prepare('SELECT * FROM clarifications WHERE id = ?').get(id) as
    | ClarificationRow
    | undefined
  return row === undefined ? undefined : toClarification(row)
}
