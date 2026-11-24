import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDatabase } from '../../src/interfaces/cli/doctor'
import { openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

/**
 * M2 review #8：doctor 必须真的检查 SQLite。
 * 之前 hubDir 可写就当“就绪”，把 state.db 做成目录也能过。
 */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-doctor-'))
  dirs.push(dir)
  return dir
}

describe('doctor: 数据库自检', () => {
  it('不存在时验证可建库，并清理痕迹', () => {
    const dir = tempDir()
    const path = join(dir, 'state.db')

    const probe = probeDatabase(path)
    expect(probe.ok).toBe(true)
    expect(probe.detail).toContain('已验证可建库')
  })

  it('已存在且结构正常时通过', () => {
    const dir = tempDir()
    const path = join(dir, 'state.db')
    const db = openDatabase(path)
    migrate(db)
    db.close()

    const probe = probeDatabase(path)
    expect(probe.ok).toBe(true)
    expect(probe.detail).toContain('quick_check 通过')
  })

  it('库已存在但未迁移时，报告待应用迁移', () => {
    const dir = tempDir()
    const path = join(dir, 'state.db')
    // 只建库、不迁移
    const db = openDatabase(path)
    db.close()

    const probe = probeDatabase(path)
    expect(probe.ok).toBe(true)
    expect(probe.detail).toContain('待应用迁移')
    expect(probe.detail).toContain('001-init')
  })

  it('路径是目录时失败（之前被漏掉的场景）', () => {
    const dir = tempDir()
    const path = join(dir, 'state.db')
    mkdirSync(path)

    const probe = probeDatabase(path)
    expect(probe.ok).toBe(false)
    expect(probe.detail).toContain('不可用')
  })
})
