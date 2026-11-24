import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/agent-host/agent-host'
import type { AgentExit, AgentHostEvent, AgentTimeouts } from '../../src/agent-host/types'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { HubError } from '../../src/shared/errors'

const dirs: string[] = []
const hosts: AgentHost[] = []

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.dispose()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-host-'))
  dirs.push(dir)
  return dir
}

function timeouts(overrides: Partial<AgentTimeouts> = {}): Partial<AgentTimeouts> {
  return { startupMs: 2_000, idleMs: 2_000, totalMs: 10_000, killGraceMs: 100, ...overrides }
}

function script(source: string): string[] {
  return [process.execPath, '-e', source]
}

class FakeProvider implements SandboxProvider {
  argv: string[] = script('')
  env: Record<string, string | undefined> = { PATH: process.env.PATH ?? '' }
  commandId: string | undefined
  error: unknown
  readonly specs: SandboxSpec[] = []
  readonly released: string[] = []

  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(_command: string, spec: SandboxSpec): Promise<SandboxedCommand> {
    this.specs.push(spec)
    if (this.error !== undefined) throw this.error
    return {
      argv: this.argv,
      env: this.env,
      ...(this.commandId === undefined ? {} : { commandId: this.commandId }),
    }
  }

  release(commandId: string): void {
    this.released.push(commandId)
  }

  async dispose(): Promise<void> {}
}

function hostWith(
  provider: FakeProvider,
  options: { timeouts?: Partial<AgentTimeouts> } = {},
): AgentHost {
  const host = new AgentHost({ provider, timeouts: timeouts(options.timeouts) })
  hosts.push(host)
  return host
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('AgentHost：启动与 stdio', () => {
  it('cwd 由 worktree 强制，调用方无法另传', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    const host = hostWith(provider)

    const process = await host.spawn('p1', {
      worktree: dir,
      command: 'ignored',
      sandbox: { allowedWrite: [`${dir}/src`] },
    })
    await process.wait()

    expect(provider.specs).toHaveLength(1)
    expect(provider.specs[0]?.cwd).toBe(dir)
    expect(provider.specs[0]?.allowedWrite).toEqual([`${dir}/src`])
  })

  it('stdout/stderr 分行，stderr 不混入 stdout', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script(`
      setTimeout(() => {
        console.log('out-1')
        console.error('err-1')
        console.log('out-2')
      }, 20)
    `)
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const events: AgentHostEvent[] = []
    host.onEvent((event) => events.push(event))
    const exit = await process.wait()

    expect(exit.reason).toBe('exited')
    expect(exit.code).toBe(0)
    expect(exit.stdout).toContain('out-1')
    expect(exit.stdout).toContain('out-2')
    expect(exit.stdout).not.toContain('err-1')
    expect(exit.stderr).toContain('err-1')

    const stdoutLines = events.filter((event) => event.type === 'stdout').map((event) => event.line)
    expect(stdoutLines).toContain('out-1')
    expect(stdoutLines).toContain('out-2')
  })

  it('writeLine 按行写入 stdin，endInput 后进程能正常退出', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script(`
      process.stdin.setEncoding('utf8')
      let buffer = ''
      process.stdin.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\\n')
        buffer = lines.pop()
        for (const line of lines) console.log('echo:' + line)
      })
    `)
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    expect(process.writeLine('hello')).toBe(true)
    expect(() => process.writeLine('bad\nline')).toThrowError(/单行/)
    process.endInput()
    const exit = await process.wait()

    expect(exit.stdout).toContain('echo:hello')
  })

  it('writeLineAsync 在 stdin 背压时等待 drain，不丢行', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script(`
      // 先不读 stdin，让管道填满；100ms 后再消费。
      setTimeout(() => {
        process.stdin.resume()
        process.stdin.on('data', () => {})
        setTimeout(() => process.exit(0), 150)
      }, 100)
    `)
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    for (let index = 0; index < 2000; index += 1) {
      await process.writeLineAsync(`line-${index}-${'x'.repeat(80)}`)
    }
    process.endInput()
    const exit = await process.wait()
    expect(exit.reason).toBe('exited')
    expect(exit.code).toBe(0)
  })

  it('自然退出保留退出码', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script('process.exit(3)')
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const exit = await process.wait()
    expect(exit.reason).toBe('exited')
    expect(exit.code).toBe(3)
  })
})

describe('AgentHost：失败路径', () => {
  it('相对 worktree 被拒，且不调用 provider', async () => {
    const provider = new FakeProvider()
    const host = hostWith(provider)

    await expect(host.spawn('p1', { worktree: 'relative', command: 'x' })).rejects.toMatchObject({
      code: 'AGENT_HOST_FAILED',
    })
    expect(provider.specs).toHaveLength(0)
    expect(host.activeCount()).toBe(0)
  })

  it('不存在的 worktree 被拒', async () => {
    const host = hostWith(new FakeProvider())
    await expect(
      host.spawn('p1', { worktree: '/definitely/not/a/worktree', command: 'x' }),
    ).rejects.toMatchObject({ code: 'AGENT_HOST_FAILED' })
    expect(host.activeCount()).toBe(0)
  })

  it('provider 的 SANDBOX_UNAVAILABLE 原样上抛，不注册进程', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.error = new HubError('SANDBOX_UNAVAILABLE', 'no srt')
    const host = hostWith(provider)

    await expect(host.spawn('p1', { worktree: dir, command: 'x' })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(host.activeCount()).toBe(0)
    expect(host.get('p1')).toBeUndefined()
  })

  it('spawn 失败（命令不存在）以 spawn_error 收敛', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = ['/definitely/not/a/command']
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const exit = await process.wait()
    expect(exit.reason).toBe('spawn_error')
    expect(exit.code).toBeNull()
    expect(exit.error).toBeTruthy()
    expect(host.activeCount()).toBe(0)
  })

  it('重复 id 在旧进程存活时被拒', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script('setInterval(() => {}, 1000)')
    const host = hostWith(provider)

    const first = await host.spawn('p1', { worktree: dir, command: 'x' })
    await expect(host.spawn('p1', { worktree: dir, command: 'y' })).rejects.toMatchObject({
      code: 'AGENT_HOST_FAILED',
    })
    await first.cancel()
    await expect(host.spawn('p1', { worktree: dir, command: 'z' })).resolves.toBeDefined()
  })

  it('非法超时/输出上限在启动前被拒', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    const host = hostWith(provider)

    await expect(
      host.spawn('p1', { worktree: dir, command: 'x', timeouts: { startupMs: 0 } }),
    ).rejects.toMatchObject({ code: 'AGENT_HOST_FAILED' })
    await expect(
      host.spawn('p2', { worktree: dir, command: 'x', maxStdoutBytes: 0 }),
    ).rejects.toMatchObject({ code: 'AGENT_HOST_FAILED' })
    expect(provider.specs).toHaveLength(0)
  })
})

describe('AgentHost：三层超时', () => {
  it('startup timeout：首段输出前超时', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script('setInterval(() => {}, 1000)')
    const host = hostWith(provider)

    const process = await host.spawn('p1', {
      worktree: dir,
      command: 'x',
      timeouts: timeouts({ startupMs: 100, idleMs: 2_000, totalMs: 5_000 }),
    })
    const exit = await process.wait()
    expect(exit.reason).toBe('startup_timeout')
    expect(exit.code).toBeNull()
  })

  it('idle timeout：首段输出后卡住', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script(
      "setTimeout(() => console.log('ready'), 10); setInterval(() => {}, 1000)",
    )
    const host = hostWith(provider)

    const process = await host.spawn('p1', {
      worktree: dir,
      command: 'x',
      timeouts: timeouts({ startupMs: 1_000, idleMs: 120, totalMs: 5_000 }),
    })
    const exit = await process.wait()
    expect(exit.reason).toBe('idle_timeout')
    expect(exit.stdout).toContain('ready')
  })

  it('total timeout：持续有输出也会被总时长截断', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script("setInterval(() => console.log('tick'), 20)")
    const host = hostWith(provider)

    const process = await host.spawn('p1', {
      worktree: dir,
      command: 'x',
      timeouts: timeouts({ startupMs: 3_000, idleMs: 3_000, totalMs: 1_500 }),
    })
    const exit = await process.wait()
    expect(exit.reason).toBe('total_timeout')
    expect(exit.stdout).toContain('tick')
  })
})

describe('AgentHost：输出上限与取消', () => {
  it('stdout 超过上限即终止并标记 truncated', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script("setInterval(() => process.stdout.write('x'.repeat(100)), 10)")
    const host = hostWith(provider)

    const process = await host.spawn('p1', {
      worktree: dir,
      command: 'x',
      maxStdoutBytes: 300,
      timeouts: timeouts({ startupMs: 1_000, idleMs: 1_000, totalMs: 5_000 }),
    })
    const exit = await process.wait()
    expect(exit.reason).toBe('output_limit')
    expect(exit.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(exit.stdout, 'utf8')).toBeLessThanOrEqual(300)
  })

  it('cancel 走 SIGTERM，退出原因为 canceled', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script('setInterval(() => {}, 1000)')
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const exit = await process.cancel()
    expect(exit.reason).toBe('canceled')
    expect(host.activeCount()).toBe(0)
  })

  it('取消会收掉整个进程组（grandchild 一并退出）', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script(`
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      setTimeout(() => console.log(child.pid), 50)
      setInterval(() => {}, 1000)
    `)
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    let grandchild: number | undefined
    process.onEvent((event) => {
      if (event.type === 'stdout' && grandchild === undefined) grandchild = Number(event.line)
    })
    await waitFor(() => grandchild !== undefined && Number.isFinite(grandchild))
    const pid = grandchild as number

    try {
      await process.cancel()
      await waitFor(() => !isAlive(pid))
      expect(isAlive(pid)).toBe(false)
    } finally {
      if (isAlive(pid)) process.kill('SIGKILL')
    }
  })
})

describe('AgentHost：ACP stdio 往返冒烟', () => {
  it.skipIf(process.platform === 'win32')(
    '经 shell 包装层发一行 JSON-RPC、收一行响应，然后取消进程组',
    async () => {
      const dir = worktree()
      const provider = new FakeProvider()
      const script = `
        process.stdin.setEncoding('utf8')
        let buffer = ''
        process.stdin.on('data', (chunk) => {
          buffer += chunk
          const lines = buffer.split('\\n')
          buffer = lines.pop()
          for (const line of lines) {
            const request = JSON.parse(line)
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { protocolVersion: 1 },
            }) + '\\n')
          }
        })
        setInterval(() => {}, 1000)
      `
      const encoded = Buffer.from(script, 'utf8').toString('base64')
      provider.argv = [
        '/bin/bash',
        '-c',
        `exec "${process.execPath}" -e "eval(Buffer.from(process.argv[1],'base64').toString())" ${encoded}`,
      ]
      const host = hostWith(provider)

      const agentProcess = await host.spawn('acp', { worktree: dir, command: 'acp-harness' })
      const lines: string[] = []
      agentProcess.onEvent((event) => {
        if (event.type === 'stdout') lines.push(event.line)
      })

      expect(
        agentProcess.writeLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' })),
      ).toBe(true)
      await waitFor(() => lines.length > 0)

      const response = JSON.parse(lines[0] ?? '{}') as {
        id?: number
        result?: { protocolVersion?: number }
      }
      expect(response.id).toBe(7)
      expect(response.result?.protocolVersion).toBe(1)

      const exit = await agentProcess.cancel()
      expect(exit.reason).toBe('canceled')
      expect(host.activeCount()).toBe(0)
    },
  )
})

describe('AgentHost：生命周期与释放', () => {
  it('退出后 release per-command 资源', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.commandId = 'net-key'
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    await process.wait()
    expect(provider.released).toEqual(['net-key'])
  })

  it('取消时也 release', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.commandId = 'net-key'
    provider.argv = script('setInterval(() => {}, 1000)')
    const host = hostWith(provider)

    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    await process.cancel()
    expect(provider.released).toEqual(['net-key'])
  })

  it('killAll 收掉所有活跃进程', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script('setInterval(() => {}, 1000)')
    const host = hostWith(provider)

    const first = await host.spawn('p1', { worktree: dir, command: 'x' })
    const second = await host.spawn('p2', { worktree: dir, command: 'y' })
    expect(host.activeCount()).toBe(2)

    await host.killAll()
    const exits = await Promise.all([first.wait(), second.wait()])
    expect(exits.map((exit) => exit.reason)).toEqual(['canceled', 'canceled'])
    expect(host.activeCount()).toBe(0)
  })

  it('dispose 后拒绝新进程，且只清理一次', async () => {
    const dir = worktree()
    const host = hostWith(new FakeProvider())
    await host.dispose()
    await host.dispose()

    await expect(host.spawn('p1', { worktree: dir, command: 'x' })).rejects.toMatchObject({
      code: 'AGENT_HOST_FAILED',
    })
  })

  it('事件带进程 id', async () => {
    const dir = worktree()
    const provider = new FakeProvider()
    provider.argv = script("setTimeout(() => console.log('hi'), 10)")
    const host = hostWith(provider)

    const events: AgentHostEvent[] = []
    host.onEvent((event) => events.push(event))
    const process = await host.spawn('p1', { worktree: dir, command: 'x' })
    const exit: AgentExit = await process.wait()

    expect(events.every((event) => event.id === 'p1')).toBe(true)
    expect(events.some((event) => event.type === 'spawned')).toBe(true)
    expect(events.some((event) => event.type === 'exit' && event.exit.reason === 'exited')).toBe(
      true,
    )
    expect(exit.reason).toBe('exited')
  })
})
