import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLock } from '../../src/shared/lock'

async function lockFixture(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hubagent-lock-'))
  return { dir, path: join(dir, 'hubagent.lock') }
}

describe('single instance lock', () => {
  it('第二次获取会失败（LOCK_HELD）', async () => {
    const { dir, path } = await lockFixture()
    const first = await acquireLock(dir, path)

    await expect(acquireLock(dir, path)).rejects.toMatchObject({ code: 'LOCK_HELD' })

    await first.release()
  })

  it('释放后可以重新获取', async () => {
    const { dir, path } = await lockFixture()
    const first = await acquireLock(dir, path)
    await first.release()

    const second = await acquireLock(dir, path)
    expect(second.pid).toBe(process.pid)
    await second.release()
  })

  it('释放是幂等的', async () => {
    const { dir, path } = await lockFixture()
    const handle = await acquireLock(dir, path)
    await handle.release()
    await handle.release()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('锁内记录了持有者 pid', async () => {
    const { dir, path } = await lockFixture()
    const handle = await acquireLock(dir, path)
    const text = await readFile(path, 'utf8')
    expect(Number.parseInt(text.trim(), 10)).toBe(process.pid)
    await handle.release()
  })

  it('陈旧锁（持有者已退出）会被清理并接管', async () => {
    const { dir, path } = await lockFixture()
    // 999999 在当前环境不应存在
    await writeFile(path, '999999\n', 'utf8')

    const handle = await acquireLock(dir, path)
    expect(handle.pid).toBe(process.pid)
    await handle.release()
  })

  it('空/不可解析的锁文件被视为被持有，绝不接管', async () => {
    const { dir, path } = await lockFixture()
    // 模拟“已 open 但 pid 还未落盘”：直接接管会造成双写
    await writeFile(path, '', 'utf8')

    await expect(acquireLock(dir, path)).rejects.toMatchObject({ code: 'LOCK_HELD' })
  })

  it('不可解析的锁不会被当作陈旧锁删除', async () => {
    const { dir, path } = await lockFixture()
    await writeFile(path, 'garbage', 'utf8')

    await expect(acquireLock(dir, path)).rejects.toMatchObject({ code: 'LOCK_HELD' })
    expect(await readFile(path, 'utf8')).toBe('garbage')
  })
})
