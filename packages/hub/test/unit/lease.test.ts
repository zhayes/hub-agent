import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireLease,
  activeLeases,
  listLeases,
  releaseLease,
  sweepExpiredLeases,
} from '../../src/runtime/workspace/lease'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  value
    .prepare(
      `INSERT INTO projects (id, name, root_path, vcs, allowed_paths, isolation, created_at)
       VALUES ('p1', 'project', '/tmp/project', 'git', '[]', 'worktree', @at)`,
    )
    .run({ at: new Date().toISOString() })
  return value
}

describe('WorkspaceLease：同一 worktree 只允许一个写入者', () => {
  it('同路径重复租用被拒；不同 worktree 可以并行', () => {
    const database = db()
    const first = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e1',
      mode: 'worktree',
      path: '/tmp/worktrees/a',
      holderAgentId: 'a1',
    })
    expect(first.status).toBe('active')

    expect(() =>
      acquireLease(database, {
        projectId: 'p1',
        executionId: 'e2',
        mode: 'worktree',
        path: '/tmp/worktrees/a',
        holderAgentId: 'a2',
      }),
    ).toThrowError(/占用/)

    const second = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e2',
      mode: 'worktree',
      path: '/tmp/worktrees/b',
      holderAgentId: 'a2',
    })
    expect(activeLeases(database, 'p1')).toHaveLength(2)
    expect(listLeases(database, 'p1').map((lease) => lease.path)).toContain(second.path)
  })

  it('release 后同一路径可重新租用', () => {
    const database = db()
    const lease = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e1',
      mode: 'worktree',
      path: '/tmp/worktrees/a',
      holderAgentId: 'a1',
    })
    releaseLease(database, lease.id)
    const next = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e2',
      mode: 'worktree',
      path: '/tmp/worktrees/a',
      holderAgentId: 'a2',
    })
    expect(next.executionId).toBe('e2')
  })

  it('过期租约被 sweep 后不再阻塞', () => {
    const database = db()
    const lease = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e1',
      mode: 'worktree',
      path: '/tmp/worktrees/a',
      holderAgentId: 'a1',
      ttlMs: 1,
    })
    const expired = sweepExpiredLeases(database, new Date(Date.now() + 5_000))
    expect(expired).toBe(1)
    expect(listLeases(database, 'p1')[0]?.status).toBe('expired')

    const next = acquireLease(database, {
      projectId: 'p1',
      executionId: 'e2',
      mode: 'worktree',
      path: '/tmp/worktrees/a',
      holderAgentId: 'a2',
    })
    expect(next.id).not.toBe(lease.id)
  })

  it('shared 只读租约可与另一个 shared 共存，但不能与写入租约重叠', () => {
    const database = db()
    acquireLease(database, {
      projectId: 'p1',
      executionId: 'e1',
      mode: 'shared',
      path: '/tmp/project',
      holderAgentId: 'a1',
    })
    acquireLease(database, {
      projectId: 'p1',
      executionId: 'e2',
      mode: 'shared',
      path: '/tmp/project',
      holderAgentId: 'a2',
    })
    expect(activeLeases(database, 'p1')).toHaveLength(2)

    expect(() =>
      acquireLease(database, {
        projectId: 'p1',
        executionId: 'e3',
        mode: 'worktree',
        path: '/tmp/project/sub',
        holderAgentId: 'a3',
      }),
    ).toThrowError(/占用/)
  })
})
