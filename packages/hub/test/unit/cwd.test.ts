import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/agent-host/agent-host'
import type { AgentTimeouts } from '../../src/agent-host/types'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'

const dirs: string[] = []
const hosts: AgentHost[] = []

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.dispose()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-cwd-'))
  dirs.push(dir)
  return dir
}

function timeouts(): Partial<AgentTimeouts> {
  return { startupMs: 2_000, idleMs: 2_000, totalMs: 10_000, killGraceMs: 100 }
}

class RecordProvider implements SandboxProvider {
  readonly specs: SandboxSpec[] = []

  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(_command: string, spec: SandboxSpec): Promise<SandboxedCommand> {
    this.specs.push(spec)
    return {
      argv: [process.execPath, '-e', "process.stdout.write(process.cwd() + '\\n')"],
      env: { PATH: process.env.PATH ?? '' },
    }
  }

  async dispose(): Promise<void> {}
}

/**
 * C2 回归：进程 cwd 必须就是任务 worktree。
 *
 * 这条如果静默失效，srt 对 `.git/hooks` / `.git/config` 的强制拒绝会全部
 * 以“相对 cwd”为准，等于没有保护（ADR 0002 C2）。
 */
describe('cwd = worktree（C2 回归）', () => {
  it('spawn 的 cwd 与 worktree 一致，provider 的 spec.cwd 也是同一个值', async () => {
    const dir = tempDir()
    const provider = new RecordProvider()
    const host = new AgentHost({ provider, timeouts: timeouts() })
    hosts.push(host)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const exit = await process.wait()

    expect(provider.specs).toHaveLength(1)
    expect(provider.specs[0]?.cwd).toBe(dir)
    // macOS 的 /var 是 /private/var 的符号链接，比较 realpath 才是进程视角。
    expect(exit.stdout.trim()).toBe(realpathSync(dir))
  })

  it('相对 worktree 被拒，provider 不会被调用', async () => {
    const provider = new RecordProvider()
    const host = new AgentHost({ provider, timeouts: timeouts() })
    hosts.push(host)

    await expect(
      host.spawn('p1', { worktree: 'relative/worktree', command: 'x' }),
    ).rejects.toMatchObject({ code: 'AGENT_HOST_FAILED' })
    expect(provider.specs).toHaveLength(0)
  })

  it('worktree 是普通文件而不是目录时被拒', async () => {
    const dir = tempDir()
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    const provider = new RecordProvider()
    const host = new AgentHost({ provider, timeouts: timeouts() })
    hosts.push(host)

    await expect(host.spawn('p1', { worktree: file, command: 'x' })).rejects.toMatchObject({
      code: 'AGENT_HOST_FAILED',
    })
    expect(provider.specs).toHaveLength(0)
  })
})
