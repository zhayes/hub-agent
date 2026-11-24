import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/adapters/acp/client'
import type { AcpExecutionEvent } from '../../src/adapters/acp/event'
import { AgentHost } from '../../src/agent-host/agent-host'
import type { AgentTimeouts } from '../../src/agent-host/types'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { HubError } from '../../src/shared/errors'

const mockAgent = fileURLToPath(new URL('../fixtures/acp/mock-agent.mjs', import.meta.url))
const dirs: string[] = []
const hosts: AgentHost[] = []
const clients: AcpClient[] = []

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.dispose()
  while (hosts.length > 0) await hosts.pop()?.dispose()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function timeouts(): Partial<AgentTimeouts> {
  return { startupMs: 5_000, idleMs: 5_000, totalMs: 30_000, killGraceMs: 200 }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-acp-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# mock repo\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'],
    { cwd: dir },
  )
  return dir
}

class MockProvider implements SandboxProvider {
  env: NodeJS.ProcessEnv = { ...process.env }
  readonly specs: SandboxSpec[] = []

  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(_command: string, spec: SandboxSpec): Promise<SandboxedCommand> {
    this.specs.push(spec)
    return { argv: [process.execPath, mockAgent], env: this.env }
  }

  async dispose(): Promise<void> {}
}

async function connect(
  provider: MockProvider,
  worktree: string,
  options: {
    onPermissionRequest?: ConstructorParameters<typeof AcpClient>[0]['onPermissionRequest']
  } = {},
): Promise<{
  host: AgentHost
  client: AcpClient
  agentProcess: Awaited<ReturnType<AgentHost['spawn']>>
  events: AcpExecutionEvent[]
  stderr: string[]
}> {
  const host = new AgentHost({ provider, timeouts: timeouts() })
  hosts.push(host)
  const agentProcess = await host.spawn(`acp-${Date.now()}-${Math.random()}`, {
    worktree,
    command: 'mock-acp',
    sandbox: { allowedWrite: [] },
  })
  const events: AcpExecutionEvent[] = []
  const stderr: string[] = []
  const client = new AcpClient({
    process: agentProcess,
    onEvent: (event) => events.push(event),
    onStderr: (line) => stderr.push(line),
    requestTimeoutMs: 5_000,
    initializeTimeoutMs: 5_000,
    promptTimeoutMs: 10_000,
    ...(options.onPermissionRequest === undefined
      ? {}
      : { onPermissionRequest: options.onPermissionRequest }),
  })
  clients.push(client)
  return { host, client, agentProcess, events, stderr }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('ACP client：initialize 与 session', () => {
  it('启动 + initialize 以协商结果为准', async () => {
    const dir = repo()
    const { client } = await connect(new MockProvider(), dir)

    const response = await client.start()
    expect(response.protocolVersion).toBe(1)
    expect(response.agentInfo?.name).toBe('mock-acp')
    expect(client.supportsSessionClose()).toBe(true)
    expect(client.supportsSessionResume()).toBe(false)

    const session = await client.newSession(dir)
    expect(session.sessionId).toBe('mock-session-1')
    expect(client.state.sessionId).toBe('mock-session-1')
  })

  it('粘包：initialize 响应被拆成三段也能解析', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_SPLIT: '1' }
    const { client } = await connect(provider, dir)

    const response = await client.start()
    expect(response.protocolVersion).toBe(1)
  })
})

describe('ACP client：prompt 与事件映射', () => {
  it('收齐 message / tool / plan / stopReason，stderr 不混入协议', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_DELAY_MS: '0' }
    const { client, events, stderr } = await connect(provider, dir)

    await client.start()
    await client.newSession(dir)
    const response = await client.prompt('write a file')

    expect(response.stopReason).toBe('end_turn')
    expect(events.some((event) => event.kind === 'message.delta')).toBe(true)
    expect(
      events.some(
        (event) =>
          event.kind === 'message.delta' &&
          event.role === 'agent' &&
          event.text.includes('mock agent working'),
      ),
    ).toBe(true)
    expect(events.some((event) => event.kind === 'tool.call')).toBe(true)
    expect(events.some((event) => event.kind === 'plan.updated')).toBe(true)
    expect(
      events.some((event) => event.kind === 'tool.call.update' && event.status === 'completed'),
    ).toBe(true)
    expect(events.some((event) => event.kind === 'prompt.finished')).toBe(true)
    expect(stderr.join('\n')).toContain('[mock-acp] prompt')
    expect(existsSync(join(dir, 'mock-output.txt'))).toBe(true)
  })

  it('cancel 中途打断：prompt 以 cancelled 收敛', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_DELAY_MS: '5000' }
    const { client, events } = await connect(provider, dir)

    await client.start()
    await client.newSession(dir)
    const pending = client.prompt('slow task')
    await waitFor(() => events.some((event) => event.kind === 'message.delta'))
    await client.cancel()

    const response = await pending
    expect(response.stopReason).toBe('cancelled')
  })
})

describe('ACP client：权限请求', () => {
  it('默认拒绝：permission 事件为 deny，且工具副作用未发生', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = {
      ...process.env,
      MOCK_ACP_DELAY_MS: '0',
      MOCK_ACP_REQUEST_PERMISSION: '1',
    }
    const { client, events } = await connect(provider, dir)

    await client.start()
    await client.newSession(dir)
    const response = await client.prompt('write with permission')

    expect(response.stopReason).toBe('refusal')
    expect(
      events.some((event) => event.kind === 'permission.requested' && event.decision === 'deny'),
    ).toBe(true)
    expect(existsSync(join(dir, 'mock-output.txt'))).toBe(false)
  })

  it('显式 handler 选择 allow_once 后继续执行', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = {
      ...process.env,
      MOCK_ACP_DELAY_MS: '0',
      MOCK_ACP_REQUEST_PERMISSION: '1',
    }
    const { client, events } = await connect(provider, dir, {
      onPermissionRequest: (request) => {
        const allow = request.options.find((option) => option.kind === 'allow_once')
        if (allow === undefined) return { outcome: { outcome: 'cancelled' } }
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      },
    })

    await client.start()
    await client.newSession(dir)
    const response = await client.prompt('write with permission')

    expect(response.stopReason).toBe('end_turn')
    expect(
      events.some((event) => event.kind === 'permission.requested' && event.decision === 'allow'),
    ).toBe(true)
    expect(existsSync(join(dir, 'mock-output.txt'))).toBe(true)
  })
})

describe('ACP client：进程被 kill', () => {
  it('kill 后 pending prompt 不会挂住，退出信号可检测', async () => {
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_DELAY_MS: '5000' }
    const { client, agentProcess } = await connect(provider, dir)

    await client.start()
    await client.newSession(dir)
    const pending = client.prompt('slow task').catch((error: unknown) => error)

    agentProcess.kill('SIGKILL')
    const exit = await agentProcess.wait()
    expect(exit.signal).toBe('SIGKILL')

    const error = await pending
    expect(error).toBeInstanceOf(HubError)
    if (error instanceof HubError) {
      expect(['AGENT_HOST_FAILED', 'ADAPTER_INCOMPATIBLE']).toContain(error.code)
    }
  })
})
