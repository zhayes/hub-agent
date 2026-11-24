import { isDeepStrictEqual } from 'node:util'
import type { DomainEvent } from '../domain/events'
import { applyEvent, type DomainState, emptyState } from '../domain/machine'
import { domainEventSchema } from '../domain/schema'
import { HubError } from '../shared/errors'
import type { Db } from './db'
import { loadState } from './queries/state'
import {
  insertVerification,
  upsertApproval,
  upsertExecution,
  upsertGoal,
  upsertSubtask,
  upsertTask,
} from './write/projections'

/**
 * 投影重建与校验（ARCHITECTURE §11.4）。
 *
 * 事件流是唯一真相：投影表随时可以被丢弃并从 `events` 重新推导。
 * 因此这里的三件事必须成立：
 *   1. 重放可失败（坏数据必须暴露，不能静默跳过）；
 *   2. 重建是**单事务**（不允许留下半重建状态）；
 *   3. 校验用逐实体深比较（不是抽样，也不是只对数）。
 */

export interface ReplayResult {
  state: DomainState
  /** 重放的事件条数 */
  events: number
  /** 最后一条事件的 seq；空库为 0 */
  lastSeq: number
}

export interface RebuildResult {
  events: number
  lastAppliedSeq: number
}

export interface VerifyResult {
  ok: boolean
  /** 形如 `tasks:<id>` / `goal` 的差异列表，空表示一致 */
  mismatches: string[]
}

interface EventRow {
  seq: number
  type: string
  payload: string
}

/** 删除顺序必须满足外键：先删子表，再删父表。 */
const PROJECTION_TABLES = [
  'verification_runs',
  'approvals',
  'executions',
  'subtasks',
  'tasks',
  'goals',
] as const

/**
 * 按 seq 顺序重放全部事件，得到领域快照。
 *
 * 任一条 payload 不合法或迁移被拒，都抛 `REPLAY_REJECTED` 并带上 seq——
 * 坏数据必须在重放阶段暴露，否则重建会把错误固化进投影。
 */
export function replayAll(db: Db): ReplayResult {
  const rows = db
    .prepare('SELECT seq, type, payload FROM events ORDER BY seq ASC')
    .all() as EventRow[]

  let state = emptyState

  for (const row of rows) {
    const event = parseEvent(row)
    const outcome = applyEvent(state, event)
    if (!outcome.ok) {
      throw new HubError(
        'REPLAY_REJECTED',
        `seq ${row.seq}（${row.type}）重放被拒：${outcome.error.message}`,
        { seq: row.seq, eventType: row.type, code: outcome.error.code },
      )
    }
    state = outcome.state
  }

  return {
    state,
    events: rows.length,
    lastSeq: rows.at(-1)?.seq ?? 0,
  }
}

function parseEvent(row: EventRow): DomainEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HubError('REPLAY_REJECTED', `seq ${row.seq} 的 payload 不是合法 JSON：${message}`, {
      seq: row.seq,
      eventType: row.type,
    })
  }

  const result = domainEventSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new HubError(
      'REPLAY_REJECTED',
      `seq ${row.seq} 的 payload 不符合事件 schema：${issues}`,
      { seq: row.seq, eventType: row.type },
    )
  }

  return result.data
}

/**
 * 丢弃全部投影并按事件流重建。
 *
 * 前置：不允许存在派发契约（`delegation_contracts`）——
 * 契约不是事件派生的，删掉就再也回不来，属于静默数据丢失。
 * 这里选择 fail-closed 而不是"顺手删掉"。
 */
export function rebuildProjections(db: Db): RebuildResult {
  const contracts = db.prepare('SELECT COUNT(*) AS n FROM delegation_contracts').get() as
    | { n: number }
    | undefined
  const contractCount = contracts?.n ?? 0
  if (contractCount > 0) {
    throw new HubError(
      'PROJECTION_MISMATCH',
      `存在 ${contractCount} 条委派契约；契约不由事件派生，重建投影会丢失，请先结束或归档`,
      { contracts: contractCount },
    )
  }

  // 先重放（失败即中止，不碰投影），再在单事务里整体替换。
  const replayed = replayAll(db)

  db.transaction(() => {
    for (const table of PROJECTION_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run()
    }

    writeState(db, replayed.state)

    db.prepare(
      `INSERT INTO projection_meta (key, value) VALUES ('last_applied_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(replayed.lastSeq))
  })()

  return { events: replayed.events, lastAppliedSeq: replayed.lastSeq }
}

/** 写入顺序同样要满足外键：父表先写。 */
function writeState(db: Db, state: DomainState): void {
  for (const goal of Object.values(state.goals)) upsertGoal(db, goal)
  for (const task of Object.values(state.tasks)) upsertTask(db, task)
  for (const subtask of Object.values(state.subtasks)) upsertSubtask(db, subtask)
  for (const execution of Object.values(state.executions)) upsertExecution(db, execution)
  for (const run of Object.values(state.verifications)) insertVerification(db, run)
  for (const approval of Object.values(state.approvals)) upsertApproval(db, approval)
}

/**
 * 校验投影与事件重放结果是否逐条一致。
 *
 * 只读：不写库、不修数据。发现差异时返回清单，由调用方决定是否重建。
 */
export function verifyProjections(db: Db): VerifyResult {
  const replayed = replayAll(db).state
  const projected = loadState(db)
  const mismatches: string[] = []

  collectMismatches('goals', replayed.goals, projected.goals, mismatches)

  collectMismatches('tasks', replayed.tasks, projected.tasks, mismatches)
  collectMismatches('subtasks', replayed.subtasks, projected.subtasks, mismatches)
  collectMismatches('executions', replayed.executions, projected.executions, mismatches)
  collectMismatches('verifications', replayed.verifications, projected.verifications, mismatches)
  collectMismatches('approvals', replayed.approvals, projected.approvals, mismatches)

  return { ok: mismatches.length === 0, mismatches }
}

function collectMismatches(
  label: string,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  out: string[],
): void {
  const ids = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const id of ids) {
    if (!isDeepStrictEqual(left[id], right[id])) {
      out.push(`${label}:${id}`)
    }
  }
}

/** 供维护命令展示：投影当前记录的位点（无记录时为 0）。 */
export function appliedSeq(db: Db): number {
  const row = db
    .prepare("SELECT value FROM projection_meta WHERE key = 'last_applied_seq'")
    .get() as { value: string } | undefined
  if (row === undefined) return 0
  const parsed = Number(row.value)
  return Number.isFinite(parsed) ? parsed : 0
}
