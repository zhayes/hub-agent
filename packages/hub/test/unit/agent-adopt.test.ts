import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptAgent, loginAgent, verifyAgent } from '../../src/runtime/agent-adopt'
import type { Catalog } from '../../src/runtime/agent-discovery/catalog'
import { findAgentByName } from '../../src/runtime/agent-registry'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const mockAgent = fileURLToPath(new URL('../fixtures/acp/mock-agent.mjs', import.meta.url))
const authAgent = fileURLToPath(new URL('../fixtures/acp/mock-agent-auth.mjs', import.meta.url))
const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function tempDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  return db
}

/** 把目录里的命令映射到测试 fixture，避免依赖 srt。 */
class MockProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    if (command === 'ok-acp') {
      return {
        argv: [process.execPath, mockAgent],
        env: { ...process.env, MOCK_ACP_DELAY_MS: '0' },
      }
    }
    if (command === 'auth-acp') {
      return { argv: [process.execPath, authAgent], env: { ...process.env } }
    }
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

function catalogFor(command: string): Catalog {
  return {
    version: 7,
    entries: [
      {
        id: 'demo',
        label: 'Demo',
        name: 'demo',
        variants: [
          {
            id: 'default',
            detect: { kind: 'path', paths: [mockAgent] },
            command,
            allowedWrite: ['~/.demo'],
          },
        ],
      },
    ],
  }
}

describe('adopt：接入与状态记录', () => {
  it('接入成功后 status=online，记录 capabilities 与目录绑定', async () => {
    const db = tempDb()
    const home = tempDir('hubagent-adopt-')
    const result = await adoptAgent({
      db,
      provider: new MockProvider(),
      home,
      userHome: home,
      catalogId: 'demo',
      catalog: catalogFor('ok-acp'),
    })

    expect(result.probe.ok).toBe(true)
    expect(result.agent.name).toBe('demo')
    expect(result.agent.status).toBe('online')
    expect(result.agent.catalogId).toBe('demo')
    expect(result.agent.catalogVersion).toBe(7)
    expect(result.agent.variantId).toBe('default')
    expect(result.agent.allowedWrite).toEqual([join(home, '.demo')])
    expect(result.agent.lastProbeAt).toBeTruthy()
    expect(result.agent.lastProbeError).toBeUndefined()
    expect(result.agent.capabilities).toEqual({
      loadSession: false,
      sessionCapabilities: { close: {} },
    })
  })

  it('需要登录时 status=needs_auth，并带回登录方式', async () => {
    const db = tempDb()
    const home = tempDir('hubagent-adopt-auth-')
    const result = await adoptAgent({
      db,
      provider: new MockProvider(),
      home,
      userHome: home,
      catalogId: 'demo',
      catalog: catalogFor('auth-acp'),
    })

    expect(result.probe.ok).toBe(false)
    expect(result.probe.status).toBe('needs_auth')
    expect(result.probe.authMethods.map((method) => method.id)).toEqual(['oauth', 'token', 'tui'])
    expect(result.agent.status).toBe('needs_auth')
    expect(result.agent.lastProbeError).toContain('需要登录')
  })

  it('重新验证会更新状态，且不改目录绑定', async () => {
    const db = tempDb()
    const home = tempDir('hubagent-verify-')
    await adoptAgent({
      db,
      provider: new MockProvider(),
      home,
      userHome: home,
      catalogId: 'demo',
      catalog: catalogFor('auth-acp'),
    })
    const before = findAgentByName(db, 'demo')
    expect(before?.status).toBe('needs_auth')

    const verified = await verifyAgent({
      db,
      provider: new MockProvider(),
      home,
      name: 'demo',
      now: new Date('2026-11-26T01:00:00Z'),
    })
    expect(verified.agent.status).toBe('needs_auth')
    expect(verified.agent.lastProbeAt).toBe('2026-11-26T01:00:00.000Z')
    expect(verified.agent.catalogId).toBe('demo')
  })

  it('login 走 agent 类型的登录方式；terminal 类型被拒绝', async () => {
    const db = tempDb()
    const home = tempDir('hubagent-login-')
    await adoptAgent({
      db,
      provider: new MockProvider(),
      home,
      catalogId: 'demo',
      catalog: catalogFor('auth-acp'),
    })

    const ok = await loginAgent({
      db,
      provider: new MockProvider(),
      home,
      name: 'demo',
      methodId: 'oauth',
    })
    expect(ok.ok).toBe(true)

    const terminal = await loginAgent({
      db,
      provider: new MockProvider(),
      home,
      name: 'demo',
      methodId: 'tui',
    })
    expect(terminal.ok).toBe(false)
    expect(terminal.error?.code).toBe('ACTION_REJECTED')
  })

  it('目录里没有该条目时报 NOT_FOUND', async () => {
    const db = tempDb()
    await expect(
      adoptAgent({
        db,
        provider: new MockProvider(),
        home: tempDir('hubagent-missing-'),
        catalogId: 'nope',
        catalog: catalogFor('ok-acp'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
