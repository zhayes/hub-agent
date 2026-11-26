import { createHash } from 'node:crypto'
import { newId } from '../../shared/id'
import type { Db } from '../../storage/db'

/**
 * idempotencyKey 只由 Runtime 已落库的事实派生（PRD §13.5.5）：
 * goalId | subtaskId | attempt | intentKey?
 */
export function deriveIdempotencyKey(input: {
  goalId: string
  subtaskId: string
  attempt: number
  intentKey?: string
}): string {
  const material = [
    input.goalId,
    input.subtaskId,
    String(input.attempt),
    input.intentKey ?? '',
  ].join('|')
  const digest = createHash('sha256').update(material).digest()
  return base32(digest)
}

/**
 * Execution ID 由幂等键确定性派生（ADR 0027 D4）。
 *
 * 同一个 (goal, subtask, attempt) 重放得到同一个 executionId，于是数据库
 * 主键本身成为第二道去重闸门：即便上游漏了幂等检查，也不可能出现两条执行。
 *
 * 注意：结果只有 26 个 Crockford 字符、形状像 ULID，但**前 10 位不是时间戳**，
 * 不要用它推时间或依赖它排序。
 */
export function deriveExecutionId(idempotencyKey: string): string {
  if (idempotencyKey === '') {
    throw new Error('deriveExecutionId 需要非空 idempotencyKey')
  }
  const digest = createHash('sha256').update(`execution|${idempotencyKey}`).digest()
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  for (let i = 0; i < 26; i += 1) {
    out += alphabet.charAt((digest[i] ?? 0) & 31)
  }
  return out
}

/** RFC 4648 base32 字母表（幂等键摘要用）。 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export interface DelegationContract {
  id: string
  subtaskId: string
  executionId?: string
  idempotencyKey: string
  createdAt: string
}

interface ContractRow {
  id: string
  subtask_id: string
  execution_id: string | null
  idempotency_key: string
  created_at: string
}

function toContract(row: ContractRow): DelegationContract {
  return {
    id: row.id,
    subtaskId: row.subtask_id,
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }
}

export interface ReserveDelegationInput {
  subtaskId: string
  idempotencyKey: string
  executionId?: string
  requirements?: Record<string, unknown>
  brief?: Record<string, unknown>
  workspace?: Record<string, unknown>
  budget?: Record<string, unknown>
  policy?: Record<string, unknown>
}

/**
 * 幂等占位：唯一约束在 DB 层原子去重。
 * 返回 created=false 表示命中已有契约；调用方不得再创建 Execution。
 */
export function reserveDelegation(
  db: Db,
  input: ReserveDelegationInput,
): { contract: DelegationContract; created: boolean } {
  const id = newId()
  const createdAt = new Date().toISOString()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO delegation_contracts (
         id, subtask_id, execution_id, requirements, brief, workspace, budget, policy,
         idempotency_key, created_at
       ) VALUES (
         @id, @subtaskId, @executionId, @requirements, @brief, @workspace, @budget, @policy,
         @idempotencyKey, @createdAt
       )`,
    )
    .run({
      id,
      subtaskId: input.subtaskId,
      executionId: input.executionId ?? null,
      requirements: JSON.stringify(input.requirements ?? {}),
      brief: JSON.stringify(input.brief ?? {}),
      workspace: JSON.stringify(input.workspace ?? {}),
      budget: JSON.stringify(input.budget ?? {}),
      policy: JSON.stringify(input.policy ?? {}),
      idempotencyKey: input.idempotencyKey,
      createdAt,
    })

  const row = db
    .prepare('SELECT * FROM delegation_contracts WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as ContractRow | undefined
  if (row === undefined) {
    throw new Error(`delegation_contracts 写入后读不到：${input.idempotencyKey}`)
  }
  return { contract: toContract(row), created: result.changes > 0 }
}
