import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectRemoteAgent } from '../../src/adapters/a2a/client'
import { fingerprintOfCertificate, normalizeFingerprint } from '../../src/adapters/a2a/fingerprint'
import { isTerminalTaskState } from '../../src/adapters/a2a/mapping'
import {
  type A2aServerHandle,
  isLoopbackHost,
  startA2aServer,
} from '../../src/interfaces/a2a/server'
import { startHub } from '../../src/interfaces/http/server'
import type { InboundTaskRunner } from '../../src/runtime/a2a-executor'
import { registerPeer, revokePeer } from '../../src/runtime/a2a-peers'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []
const handles: A2aServerHandle[] = []
const hubClosers: Array<() => Promise<void>> = []
const dirs: string[] = []

afterEach(async () => {
  while (hubClosers.length > 0) await hubClosers.pop()?.()
  while (handles.length > 0) await handles.pop()?.close()
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

function pem(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/a2a-tls/${name}`, import.meta.url))
}

const CA = pem('ca.crt')
const SERVER = { cert: pem('server.crt'), key: pem('server.key') }
const CLIENT_A = { cert: pem('client-a.crt'), key: pem('client-a.key') }
const CLIENT_B = { cert: pem('client-b.crt'), key: pem('client-b.key') }
const ROGUE_CLIENT = { cert: pem('rogue-client.crt'), key: pem('rogue-client.key') }

function fingerprintOf(pemCert: Buffer): string {
  return fingerprintOfCertificate(new X509Certificate(pemCert).raw)
}

const stubProvider = {
  describe: () => ({ kind: 'srt', platform: 'test', ready: true, detail: '' }),
  wrap: () => {
    throw new Error('stub provider 不该被调用')
  },
  dispose: async () => {},
} as unknown as SandboxProvider

const recordingRunner = (): InboundTaskRunner & { received: string[] } => {
  const received: string[] = []
  return {
    received,
    run: async ({ objective }) => {
      received.push(objective)
      return { state: 'completed', summary: 'done' }
    },
    cancel: async () => ({ contextId: 'ctx' }),
  }
}

/** 起一个要求客户端证书（mTLS）的入站面。 */
async function startMtlsServer(
  database: Db,
  runner: InboundTaskRunner = recordingRunner(),
): Promise<A2aServerHandle> {
  const handle = await startA2aServer({
    db: database,
    provider: stubProvider,
    version: '0.0.0-test',
    worktree: '/tmp',
    port: 0,
    tls: { ...SERVER, ca: CA, requireClientCert: true },
    runner,
  })
  handles.push(handle)
  return handle
}

/** 真实的 mTLS 客户端：用 node:https 发请求，携带客户端证书。 */
function mtlsClient(url: string, material: { cert: Buffer; key: Buffer }, token?: string) {
  return connectRemoteAgent({
    url,
    ...(token === undefined ? {} : { token }),
    tls: { cert: material.cert, key: material.key, ca: CA },
  })
}

async function waitTerminal(
  client: Awaited<ReturnType<typeof connectRemoteAgent>>,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await client.get(taskId)
    if (isTerminalTaskState(task.status?.state ?? 0)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('任务未在预期时间内到终态')
}

describe('证书指纹', () => {
  it('同一份 DER 稳定得到同一指纹；外部写法被规范化', () => {
    const raw = new X509Certificate(CLIENT_A.cert).raw
    const fp = fingerprintOfCertificate(raw)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOfCertificate(raw)).toBe(fp)

    const upperColons = fp.match(/../g)?.join(':').toUpperCase() ?? ''
    expect(normalizeFingerprint(upperColons)).toBe(fp)
    expect(normalizeFingerprint(`  ${fp}  `)).toBe(fp)
    expect(normalizeFingerprint(undefined)).toBeNull()
    expect(normalizeFingerprint(':  :')).toBeNull()
  })
})

describe('回环判定', () => {
  it('localhost / 127.x / ::1 是回环；通配与公网不是', () => {
    for (const host of ['localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('A2A 监听面的 mTLS 前置', () => {
  it('非回环监听且未配置 tls 时拒绝启动', async () => {
    await expect(
      startA2aServer({
        db: db(),
        provider: stubProvider,
        version: '0.0.0-test',
        worktree: '/tmp',
        host: '0.0.0.0',
        port: 0,
      }),
    ).rejects.toThrow(/必须配置 tls/)
  })

  it('requireClientCert 缺 ca 时拒绝启动', async () => {
    await expect(
      startA2aServer({
        db: db(),
        provider: stubProvider,
        version: '0.0.0-test',
        worktree: '/tmp',
        port: 0,
        tls: { ...SERVER, requireClientCert: true },
      }),
    ).rejects.toThrow(/必须同时提供 ca/)
  })

  it('已绑定的客户端证书可以完成委托，且卡片走 https', async () => {
    const database = db()
    const runner = recordingRunner()
    const { peer } = registerPeer(database, {
      displayName: 'peer-a',
      certFingerprint: fingerprintOf(CLIENT_A.cert),
    })
    const handle = await startMtlsServer(database, runner)
    expect(handle.url.startsWith('https://')).toBe(true)

    const client = await mtlsClient(handle.url, CLIENT_A)
    const card = await client.card()
    expect(card.supportedInterfaces[0]?.url).toBe(handle.url)

    const sent = await client.send({ text: '用证书委托' })
    await waitTerminal(client, sent.taskId)
    expect(runner.received).toEqual(['用证书委托'])
    expect(peer.status).toBe('trusted')
  })

  it('同 CA 签发但未注册的证书被 401 拒绝，且不创建任务', async () => {
    const database = db()
    registerPeer(database, { displayName: 'peer-a', certFingerprint: fingerprintOf(CLIENT_A.cert) })
    const handle = await startMtlsServer(database)

    const client = await mtlsClient(handle.url, CLIENT_B)
    await expect(client.send({ text: '不该被受理' })).rejects.toThrow()

    const tasks = database.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get() as { n: number }
    expect(tasks.n).toBe(0)
  })

  it('撤销后证书立即失效', async () => {
    const database = db()
    const { peer } = registerPeer(database, {
      displayName: 'peer-a',
      certFingerprint: fingerprintOf(CLIENT_A.cert),
    })
    const handle = await startMtlsServer(database)
    revokePeer(database, peer.id)

    const client = await mtlsClient(handle.url, CLIENT_A)
    await expect(client.send({ text: '已撤销' })).rejects.toThrow()
  })

  it('不受信 CA 的证书在握手阶段就被拒，不进到应用层', async () => {
    const database = db()
    registerPeer(database, { displayName: 'peer-a', certFingerprint: fingerprintOf(CLIENT_A.cert) })
    const handle = await startMtlsServer(database)

    /* 握手阶段（拉卡片）就被拒，所以 `connectRemoteAgent` 本身就抛错。 */
    await expect(mtlsClient(handle.url, ROGUE_CLIENT)).rejects.toThrow()

    const tasks = database.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get() as { n: number }
    expect(tasks.n).toBe(0)
  })

  it('mTLS 模式下不降级到 token：无对应证书时携带合法 token 也无效', async () => {
    const database = db()
    const peerA = registerPeer(database, {
      displayName: 'peer-a',
      certFingerprint: fingerprintOf(CLIENT_A.cert),
    })
    const handle = await startMtlsServer(database)

    /* 用未注册的 client-b 证书 + peer-a 的合法 token：token 必须被忽略。 */
    const client = await mtlsClient(handle.url, CLIENT_B, peerA.token)
    await expect(client.send({ text: '试图降级' })).rejects.toThrow()

    const tasks = database.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get() as { n: number }
    expect(tasks.n).toBe(0)
  })

  it('daemon（startHub）能透传 tls 并接受 mTLS 委托', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hubagent-mtls-'))
    dirs.push(home)

    const hub = await startHub({
      version: '0.0.0-test',
      home,
      port: 0,
      schedulerIntervalMs: 0,
      a2a: {
        enabled: true,
        port: 0,
        tls: { ...SERVER, ca: CA, requireClientCert: true },
        peers: [
          {
            displayName: 'peer-a',
            token: 'bootstrap',
            certFingerprint: fingerprintOf(CLIENT_A.cert),
          },
        ],
      },
    })
    hubClosers.push(hub.close)

    expect(hub.a2a?.url.startsWith('https://')).toBe(true)
    const client = await mtlsClient(hub.a2a?.url ?? '', CLIENT_A)
    /* 能发出就说明 TLS 握手 + 证书身份映射都通了（任务后续跑成与否不属本用例）。 */
    const sent = await client.send({ text: 'daemon 上的 mTLS 委托' })
    expect(sent.taskId).not.toBe('')
  })
})
