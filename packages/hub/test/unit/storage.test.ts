import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asApprovalId, asGoalId } from '../../src/domain/ids'
import { type DomainState, emptyState } from '../../src/domain/machine'
import { HubError } from '../../src/shared/errors'
import { integrityCheck, openDatabase, pragmaValue } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { loadState } from '../../src/storage/queries/state'
import {
  appliedSeq,
  rebuildProjections,
  replayAll,
  verifyProjections,
} from '../../src/storage/rebuild'
import { appendEvent, eventCount, lastSeq } from '../../src/storage/write/events'
import { AT, execution, goal, IDS, subtask, task } from './domain-fixtures'

/**
 * M2：持久化与事件。
 *
 * 这里验的是"投影可以被丢弃"这个性质——事件流是唯一真相，
 * 所以重建必须幂等、校验必须能抓到篡改、拒绝必须零副作用。
 */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function freshDb(): ReturnType<typeof openDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-storage-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'state.db'))
  migrate(db)
  return db
}

/** goal + task + 一个子任务 + 一个执行，全部经 appendEvent 落库 */
function appendSeed(db: ReturnType<typeof openDatabase>): DomainState {
  let state: DomainState = emptyState

  state = appendEvent(db, state, { type: 'goal.created', goal }).state
  state = appendEvent(db, state, { type: 'task.created', task }).state
  state = appendEvent(db, state, {
    type: 'subtask.created',
    subtask: subtask(IDS.s1, '实现'),
  }).state
  state = appendEvent(db, state, {
    type: 'execution.created',
    execution: execution(IDS.e1, IDS.s1),
  }).state

  return state
}

describe('数据库与迁移', () => {
  it('迁移幂等：第二次不重复应用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubagent-migrate-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'state.db'))

    try {
      const first = migrate(db)
      expect(first.applied).toEqual([
        '001-init',
        '002-agents',
        '003-agent-profile',
        '004-brain',
        '005-workspace',
        '006-chat',
        '007-chat-approval',
        '008-chat-clarification',
        '009-agent-catalog',
      ])

      const second = migrate(db)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([
        '001-init',
        '002-agents',
        '003-agent-profile',
        '004-brain',
        '005-workspace',
        '006-chat',
        '007-chat-approval',
        '008-chat-clarification',
        '009-agent-catalog',
      ])
    } finally {
      db.close()
    }
  })

  it('PRAGMA 生效：WAL 且库完整', () => {
    const db = freshDb()
    try {
      expect(pragmaValue(db, 'journal_mode')).toBe('wal')
      expect(integrityCheck(db)).toBe('ok')
    } finally {
      db.close()
    }
  })
})

describe('事件追加与投影', () => {
  it('seq 单调递增，投影行与内存快照一致', () => {
    const db = freshDb()
    try {
      const state = appendSeed(db)

      expect(lastSeq(db)).toBe(4)
      expect(eventCount(db)).toBe(4)
      expect(appliedSeq(db)).toBe(4)

      expect(loadState(db)).toEqual(state)
    } finally {
      db.close()
    }
  })

  it('被拒绝的事件抛 EVENT_REJECTED 且零副作用', () => {
    const db = freshDb()
    try {
      const state = appendSeed(db)
      const before = eventCount(db)
      const beforeSeq = lastSeq(db)

      // ready → completed 不在迁移表里
      expect(() =>
        appendEvent(db, state, {
          type: 'task.status',
          taskId: IDS.task,
          to: 'completed',
          at: AT,
        }),
      ).toThrowError(HubError)

      expect(eventCount(db)).toBe(before)
      expect(lastSeq(db)).toBe(beforeSeq)
      expect(loadState(db)).toEqual(state)
    } finally {
      db.close()
    }
  })
})

describe('投影重建与校验', () => {
  it('重建后状态不变，位点追上事件流', () => {
    const db = freshDb()
    try {
      const state = appendSeed(db)

      const result = rebuildProjections(db)
      expect(result.events).toBe(4)
      expect(result.lastAppliedSeq).toBe(4)

      expect(loadState(db)).toEqual(state)
      expect(verifyProjections(db)).toEqual({ ok: true, mismatches: [] })
    } finally {
      db.close()
    }
  })

  it('篡改投影行会被校验抓到', () => {
    const db = freshDb()
    try {
      appendSeed(db)

      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('被篡改', IDS.task)

      const verified = verifyProjections(db)
      expect(verified.ok).toBe(false)
      expect(verified.mismatches).toContain(`tasks:${IDS.task}`)
    } finally {
      db.close()
    }
  })

  it('重建可以修复被篡改的投影', () => {
    const db = freshDb()
    try {
      const state = appendSeed(db)
      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('被篡改', IDS.task)

      rebuildProjections(db)

      expect(loadState(db)).toEqual(state)
      expect(verifyProjections(db).ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('坏 payload 重放时抛 REPLAY_REJECTED', () => {
    const db = freshDb()
    try {
      appendSeed(db)
      db.prepare('UPDATE events SET payload = ? WHERE seq = 1').run('{')

      expect(() => replayAll(db)).toThrowError(/REPLAY_REJECTED|合法 JSON/)
    } finally {
      db.close()
    }
  })

  it('存在委派契约时拒绝重建（fail-closed，避免静默丢数据）', () => {
    const db = freshDb()
    try {
      const state = appendSeed(db)
      const subtaskRow = state.subtasks[IDS.s1]
      expect(subtaskRow).toBeDefined()

      db.prepare(
        `INSERT INTO delegation_contracts (
           id, subtask_id, execution_id, requirements, brief, workspace,
           budget, policy, idempotency_key, created_at
         ) VALUES (?, ?, NULL, '{}', '{}', '{}', '{}', '{}', ?, ?)`,
      ).run('c1', IDS.s1, 'idem-1', AT)

      expect(() => rebuildProjections(db)).toThrowError(HubError)
      // 投影未被清空
      expect(loadState(db)).toEqual(state)
    } finally {
      db.close()
    }
  })
})

describe('审批（M2 review #1：approvals 缺 created_at）', () => {
  it('approval.requested → decided 可落库，且与重放一致', () => {
    const db = freshDb()
    try {
      let state = appendSeed(db)

      state = appendEvent(db, state, {
        type: 'approval.requested',
        approval: {
          id: asApprovalId('a1'),
          taskId: IDS.task,
          action: 'write',
          resource: '/etc/hosts',
          riskLevel: 'high',
          requestedBy: 'brain',
          reason: '需要写工作区外文件',
          status: 'pending',
          createdAt: AT,
        },
      }).state

      state = appendEvent(db, state, {
        type: 'approval.decided',
        approvalId: asApprovalId('a1'),
        status: 'approved',
        at: AT,
      }).state

      const loaded = loadState(db)
      expect(loaded.approvals['a1']?.status).toBe('approved')
      expect(loaded.approvals['a1']?.createdAt).toBe(AT)
      expect(loaded).toEqual(state)
      expect(verifyProjections(db)).toEqual({ ok: true, mismatches: [] })
    } finally {
      db.close()
    }
  })
})

describe('多 goal 持久化（M2 review #4）', () => {
  it('两个 goal 都能落库、重放并重建', () => {
    const db = freshDb()
    try {
      let state: DomainState = emptyState
      state = appendEvent(db, state, { type: 'goal.created', goal }).state
      state = appendEvent(db, state, {
        type: 'goal.created',
        goal: { ...goal, id: asGoalId('g2'), title: '第二个目标' },
      }).state
      state = appendEvent(db, state, { type: 'task.created', task }).state

      expect(Object.keys(loadState(db).goals)).toHaveLength(2)
      expect(loadState(db)).toEqual(state)

      rebuildProjections(db)
      expect(loadState(db)).toEqual(state)
      expect(verifyProjections(db).ok).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('写入前跑不变量（M2 review #2）', () => {
  it('创建事件伪造终态会被 appendEvent 拦下且不写事件', () => {
    const db = freshDb()
    try {
      const state = appendEvent(db, emptyState, { type: 'goal.created', goal }).state
      const before = eventCount(db)

      expect(() =>
        appendEvent(db, state, {
          type: 'subtask.created',
          subtask: { ...subtask(IDS.s1, 's'), status: 'succeeded' },
        }),
      ).toThrowError(HubError)

      expect(eventCount(db)).toBe(before)
      expect(state.subtasks[IDS.s1]).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('数据库不可用（M2 review #9）', () => {
  it('路径是目录时抛 DB_UNAVAILABLE，而不是 SqliteError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubagent-db-'))
    dirs.push(dir)
    const asDir = join(dir, 'state.db')
    mkdirSync(asDir)

    expect(() => openDatabase(asDir)).toThrowError(HubError)
    try {
      openDatabase(asDir)
    } catch (error) {
      expect((error as HubError).code).toBe('DB_UNAVAILABLE')
    }
  })
})
