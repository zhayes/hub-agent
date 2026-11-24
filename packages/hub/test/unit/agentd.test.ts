import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { lockPath } from '../../src/shared/paths'

/**
 * M2 review #6：hubagentd 必须真的常驻，且 SIGTERM 后释放锁。
 *
 * 用真实子进程测，因为问题本身就在"进程生命周期"上——
 * 在同一个进程里调用 main() 是测不出来的。
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const daemon = join(repoRoot, 'packages/hub/src/bin/hubagentd.ts')

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-agentd-'))
  dirs.push(dir)
  return dir
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

describe('hubagentd: 常驻与干净退出', () => {
  it('启动后仍存活；SIGTERM 后 2s 内退出且锁被释放', async () => {
    const home = tempHome()
    const child = spawn(process.execPath, ['--import', 'tsx', daemon], {
      cwd: repoRoot,
      env: { ...process.env, HUBAGENT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    let exited = false
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => {
        exited = true
        resolve()
      })
    })

    // 先等锁出现：这证明 main() 已跑过 acquireLock（而不是还在 tsx 冷启动）。
    const locked = await waitFor(() => existsSync(lockPath(home)), 10_000)
    expect(locked, `锁未出现；stderr=${stderr}`).toBe(true)
    expect(exited, `启动后立即退出；stderr=${stderr}`).toBe(false)

    // 再观察一小段：确认没有“打印后自行退出”
    await sleep(300)
    expect(exited, `启动后自行退出；stderr=${stderr}`).toBe(false)

    child.kill('SIGTERM')
    await Promise.race([exitPromise, sleep(2_000)])

    expect(exited).toBe(true)
    expect(existsSync(lockPath(home))).toBe(false)
  }, 20_000)
})
