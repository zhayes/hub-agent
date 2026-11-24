import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState } from '../../src/domain/machine'
import { runRebuildProjections } from '../../src/interfaces/cli/maintenance'
import { acquireLock } from '../../src/shared/lock'
import { dbPath, lockPath } from '../../src/shared/paths'
import { openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'
import { goal } from './domain-fixtures'

/**
 * M2 review #7：maintenance 必须与 daemon 互斥。
 * 否则 daemon 在 replay 与写事务之间追加的事件，其投影会被静默丢掉。
 */

let home: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env['HUBAGENT_HOME']
  home = mkdtempSync(join(tmpdir(), 'hubagent-maint-'))
  process.env['HUBAGENT_HOME'] = home
})

afterEach(() => {
  if (previous === undefined) delete process.env['HUBAGENT_HOME']
  else process.env['HUBAGENT_HOME'] = previous
  rmSync(home, { recursive: true, force: true })
})

function seedDb(): void {
  const db = openDatabase(dbPath(home))
  try {
    migrate(db)
    appendEvent(db, emptyState, { type: 'goal.created', goal })
  } finally {
    db.close()
  }
}

describe('maintenance: 与 daemon 互斥', () => {
  it('正常重建后释放锁', async () => {
    seedDb()

    const report = await runRebuildProjections({ verify: true })
    expect(report.ok).toBe(true)
    expect(report.rebuilt.events).toBe(1)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('锁被占用时拒绝执行（LOCK_HELD），不动数据库', async () => {
    seedDb()
    const held = await acquireLock(home, lockPath(home))

    try {
      await expect(runRebuildProjections({ verify: true })).rejects.toMatchObject({
        code: 'LOCK_HELD',
      })
    } finally {
      await held.release()
    }
  })
})
