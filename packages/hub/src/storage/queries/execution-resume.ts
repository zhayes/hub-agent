import type { VerificationCheck } from '../../domain/entities'
import type { Db } from '../db'

export interface ExecutionResumePlan {
  executionId: string
  worktree: string
  checks: VerificationCheck[]
  createdAt: string
}

interface ResumeRow {
  execution_id: string
  worktree: string
  checks_json: string
  created_at: string
}

/** 记录验收现场的时机：Agent 跑完、verification 之前。 */
export function saveExecutionResume(
  db: Db,
  input: {
    executionId: string
    worktree: string
    checks: readonly VerificationCheck[]
    now?: string
  },
): void {
  db.prepare(
    `INSERT INTO execution_resume (execution_id, worktree, checks_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(execution_id) DO UPDATE SET
       worktree = excluded.worktree,
       checks_json = excluded.checks_json,
       created_at = excluded.created_at`,
  ).run(
    input.executionId,
    input.worktree,
    JSON.stringify(input.checks),
    input.now ?? new Date().toISOString(),
  )
}

export function getExecutionResume(db: Db, executionId: string): ExecutionResumePlan | undefined {
  const row = db
    .prepare('SELECT * FROM execution_resume WHERE execution_id = ?')
    .get(executionId) as ResumeRow | undefined
  if (row === undefined) return undefined
  try {
    return {
      executionId: row.execution_id,
      worktree: row.worktree,
      checks: JSON.parse(row.checks_json) as VerificationCheck[],
      createdAt: row.created_at,
    }
  } catch {
    return undefined
  }
}
