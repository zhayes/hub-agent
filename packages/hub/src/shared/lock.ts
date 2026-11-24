import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { HubError, isErrnoWithCode } from './errors'

export interface LockHandle {
  readonly path: string
  readonly pid: number
  release(): Promise<void>
}

/**
 * 单实例锁（ARCHITECTURE §4.2 启动序列第 2 步）。
 *
 * 用 O_EXCL 创建锁文件，写入 pid；发现 EEXIST 时检查持有者是否仍存活：
 * 已死则视为陈旧锁，清理后重试一次。不引入外部依赖。
 */
export async function acquireLock(dir: string, path: string): Promise<LockHandle> {
  await mkdir(dir, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      return createHandle(path)
    } catch (error) {
      if (!isErrnoWithCode(error, 'EEXIST')) throw error

      const owner = await readOwnerPidWithGrace(path)
      if (owner === null) {
        // 空/不可解析：可能是另一个进程刚 open 但 pid 还没落盘。
        // 宁可误报被持有，也不能接管（接管会导致双写，破坏单写者前提）。
        throw new HubError('LOCK_HELD', `锁文件内容不可解析，视为已被持有：${path}`, {
          lockPath: path,
        })
      }
      if (isProcessAlive(owner)) {
        throw new HubError('LOCK_HELD', `另一个 HubAgent 实例正在运行（pid ${owner}）`, {
          lockPath: path,
          pid: owner,
        })
      }
      // 陈旧锁：清理后重试一次
      await unlink(path).catch(() => undefined)
    }
  }

  throw new HubError('LOCK_HELD', `无法获取实例锁：${path}`)
}

function createHandle(path: string): LockHandle {
  let released = false
  return {
    path,
    pid: process.pid,
    async release(): Promise<void> {
      if (released) return
      released = true
      await unlink(path).catch(() => undefined)
    },
  }
}

async function readOwnerPid(path: string): Promise<number | null> {
  try {
    const text = await readFile(path, 'utf8')
    const pid = Number.parseInt(text.trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * 给“刚创建、pid 还没写入”的窗口留一点时间。
 * 仍不可解析就交给调用方判为“被持有”，绝不当作陈旧锁删除。
 */
async function readOwnerPidWithGrace(path: string): Promise<number | null> {
  for (let i = 0; i < 4; i += 1) {
    const pid = await readOwnerPid(path)
    if (pid !== null) return pid
    await delay(25)
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但属于其他用户
    return isErrnoWithCode(error, 'EPERM')
  }
}
