import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Role } from '@a2a-js/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub } from '../../src/interfaces/http/server'

const dirs: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-a2a-daemon-'))
  dirs.push(dir)
  return dir
}

const TOKEN = 'peer-token-for-test'

async function start(home: string) {
  const handle = await startHub({
    version: '0.0.0-test',
    home,
    port: 0,
    schedulerIntervalMs: 0,
    a2a: { enabled: true, port: 0, peers: [{ displayName: 'test-peer', token: TOKEN }] },
  })
  closers.push(handle.close)
  return handle
}

function rpc(body: unknown, options: { token?: string; version?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.version !== undefined) headers['a2a-version'] = options.version
  return { method: 'POST' as const, headers, body: JSON.stringify(body) }
}

const sendParams = (text: string) => ({
  tenant: '',
  message: {
    messageId: `m-${text}`,
    role: Role.ROLE_USER,
    contextId: '',
    taskId: '',
    parts: [
      {
        content: { $case: 'text' as const, value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    extensions: [],
    referenceTaskIds: [],
    metadata: {},
  },
  configuration: undefined,
  metadata: {},
})

describe('A2A 入站面接进 daemon', () => {
  it('默认关闭；启用后是独立端口，且卡片暴露真实端口', async () => {
    const home = tempHome()
    const off = await startHub({ version: '0.0.0-test', home, port: 0, schedulerIntervalMs: 0 })
    expect(off.a2a).toBeUndefined()
    expect(off.port).toBeGreaterThan(0)
    /* 单实例锁：同一 home 同时只能有一个 daemon，所以先关再开。 */
    await off.close()

    const on = await startHub({
      version: '0.0.0-test',
      home,
      port: 0,
      schedulerIntervalMs: 0,
      a2a: { enabled: true, port: 0, peers: [{ displayName: 'p', token: TOKEN }] },
    })
    closers.push(on.close)
    expect(on.a2a?.port).toBeGreaterThan(0)
    /* 下一次 startHub 会拿到不同端口：这里只要求两者互不覆盖。 */
    expect(on.a2a?.host).toBe('127.0.0.1')

    const card = await fetch(`${on.a2a?.url.replace('/a2a', '')}/.well-known/agent-card.json`)
    expect(card.status).toBe(200)
    const body = (await card.json()) as { supportedInterfaces: Array<{ url: string }> }
    expect(body.supportedInterfaces[0]?.url).toContain(String(on.a2a?.port))
  })

  it('走真实 HTTP：未认证被拒、认证后可建任务、重启后仍可查询', async () => {
    const home = tempHome()
    const first = await start(home)
    const endpoint = first.a2a?.url ?? ''
    expect(endpoint).not.toBe('')

    /* 1. 未认证：401，且不产生任务（零副作用）。 */
    const denied = await fetch(
      endpoint,
      rpc({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: sendParams('不该执行') }),
    )
    expect(denied.status).toBe(401)

    const listAfterDenied = await fetch(
      endpoint,
      rpc(
        { jsonrpc: '2.0', id: 2, method: 'ListTasks', params: { tenant: '' } },
        { token: TOKEN, version: '1.0' },
      ),
    )
    const deniedBody = (await listAfterDenied.json()) as { result?: { totalSize: number } }
    expect(deniedBody.result?.totalSize).toBe(0)

    /* 2. 缺版本头 → 规范上按 0.3，被拒。 */
    const noVersion = await fetch(
      endpoint,
      rpc({ jsonrpc: '2.0', id: 3, method: 'ListTasks', params: { tenant: '' } }, { token: TOKEN }),
    )
    expect(((await noVersion.json()) as { error?: { code: number } }).error?.code).toBe(-32009)

    /* 3. 认证通过：请求被受理并落成 Task（本机没配 Agent，故终态可能是 FAILED，
          但“受理 + 持久化 + 可查询”这三点必须成立）。 */
    const accepted = await fetch(
      endpoint,
      rpc(
        { jsonrpc: '2.0', id: 4, method: 'SendMessage', params: sendParams('把 README 改短') },
        { token: TOKEN, version: '1.0' },
      ),
    )
    expect(accepted.status).toBe(200)
    const acceptedBody = (await accepted.json()) as {
      result?: { task?: { id: string; status?: { state: string } } }
    }
    const taskId = acceptedBody.result?.task?.id ?? ''
    expect(taskId).not.toBe('')
    expect(acceptedBody.result?.task?.status?.state).toMatch(/^TASK_STATE_/)

    /* 4. 重启同一个 home：token 与任务都应还在库里。 */
    await first.close()
    closers.pop()

    const second = await start(home)
    const fetched = await fetch(
      second.a2a?.url ?? '',
      rpc(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'GetTask',
          params: { tenant: '', id: taskId, historyLength: 0 },
        },
        { token: TOKEN, version: '1.0' },
      ),
    )
    expect(fetched.status).toBe(200)
    expect(((await fetched.json()) as { result?: { id: string } }).result?.id).toBe(taskId)
  })
})
