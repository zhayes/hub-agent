import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Catalog, parseCatalog } from '../../src/runtime/agent-discovery/catalog'
import { evaluateDetect } from '../../src/runtime/agent-discovery/detect'
import { scanAgents } from '../../src/runtime/agent-discovery/scan'
import { addAgent } from '../../src/runtime/agent-registry'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix = 'hubagent-catalog-'): string {
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

function executable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

describe('catalog：目录解析', () => {
  it('解析合法条目', () => {
    const { catalog, problems } = parseCatalog({
      version: 2,
      entries: [
        {
          id: 'demo',
          label: 'Demo',
          name: 'demo',
          variants: [
            { id: 'default', detect: { kind: 'which', name: 'demo' }, command: 'demo --acp' },
          ],
        },
      ],
    })
    expect(problems).toEqual([])
    expect(catalog.version).toBe(2)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]?.variants[0]?.command).toBe('demo --acp')
  })

  it('非法条目被丢弃并记录原因，不影响其它条目', () => {
    const { catalog, problems } = parseCatalog({
      version: 1,
      entries: [
        { id: 'bad id', label: 'Bad', name: 'bad', variants: [] },
        {
          id: 'ok',
          label: 'Ok',
          name: 'ok',
          variants: [{ id: 'default', detect: { kind: 'which', name: 'x' }, command: 'x' }],
        },
      ],
    })
    expect(catalog.entries.map((entry) => entry.id)).toEqual(['ok'])
    expect(problems[0]?.message).toContain('id')
  })

  it('command 使用 <cli> 但 detect 没有 cli → 拒绝', () => {
    const { catalog, problems } = parseCatalog({
      version: 1,
      entries: [
        {
          id: 'x',
          label: 'X',
          name: 'x',
          variants: [
            {
              id: 'default',
              detect: { kind: 'bundle', paths: ['/tmp/x'], entry: 'bin/x' },
              command: 'run "<cli>"',
            },
          ],
        },
      ],
    })
    expect(catalog.entries).toHaveLength(0)
    expect(problems[0]?.message).toContain('<cli>')
  })
})

describe('detect：静态检测不执行二进制', () => {
  const ctx = (env: Record<string, string | undefined>, home: string) => ({
    platform: 'linux' as const,
    home,
    env,
  })

  it('which 在 PATH 中查找可执行文件', () => {
    const bin = tempDir()
    executable(bin, 'demo-acp')
    const found = evaluateDetect({ kind: 'which', name: 'demo-acp' }, ctx({ PATH: bin }, tempDir()))
    expect(found.ok).toBe(true)
    expect(found.detail).toBe(join(bin, 'demo-acp'))
  })

  it('which 不存在的命令', () => {
    const found = evaluateDetect(
      { kind: 'which', name: 'nope-acp' },
      ctx({ PATH: tempDir() }, tempDir()),
    )
    expect(found.ok).toBe(false)
  })

  it('bundle 要求 entry 与 cli 存在；virtualCli 跳过 cli 检查', () => {
    const base = tempDir()
    mkdirSync(join(base, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(base, 'Contents', 'MacOS', 'App'), '')
    const rule = {
      kind: 'bundle' as const,
      paths: [base],
      entry: join('Contents', 'MacOS', 'App'),
      cli: join('Contents', 'Resources', 'app.asar', 'bin.js'),
    }
    expect(evaluateDetect(rule, ctx({}, tempDir())).ok).toBe(false)
    expect(evaluateDetect({ ...rule, virtualCli: true }, ctx({}, tempDir())).ok).toBe(true)
  })
})

describe('scan：目录 × 本机 × 注册表', () => {
  const catalog: Catalog = {
    version: 1,
    entries: [
      {
        id: 'demo',
        label: 'Demo',
        name: 'demo',
        variants: [
          {
            id: 'default',
            detect: { kind: 'which', name: 'demo-acp' },
            command: 'demo-acp --acp',
            allowedWrite: ['~/.demo'],
          },
        ],
      },
      {
        id: 'needs-adapter',
        label: 'Needs Adapter',
        name: 'needs-adapter',
        variants: [
          {
            id: 'default',
            detect: { kind: 'which', name: 'demo-base' },
            requires: [{ kind: 'which', name: 'demo-adapter' }],
            command: 'demo-adapter',
          },
        ],
      },
      {
        id: 'missing',
        label: 'Missing',
        name: 'missing',
        variants: [{ id: 'default', detect: { kind: 'which', name: 'nope' }, command: 'nope' }],
      },
    ],
  }

  it('只返回本机存在的条目；缺依赖的条目不可接入；已注册的标记出来', () => {
    const db = tempDb()
    const bin = tempDir()
    const home = tempDir()
    executable(bin, 'demo-acp')
    executable(bin, 'demo-base')
    addAgent(db, { name: 'demo', command: 'demo-acp --acp' })

    const result = scanAgents(db, {
      platform: 'linux',
      home,
      env: { PATH: bin },
      catalog,
      now: new Date('2026-11-26T00:00:00Z'),
    })

    expect(result.version).toBe(1)
    expect(result.scannedAt).toBe('2026-11-26T00:00:00.000Z')
    expect(result.agents.map((entry) => entry.catalogId)).toEqual(['demo', 'needs-adapter'])

    const demo = result.agents[0]
    expect(demo?.registered).toBe(true)
    expect(demo?.agentStatus).toBe('discovered')
    expect(demo?.variants[0]?.command).toBe('demo-acp --acp')
    expect(demo?.variants[0]?.allowedWrite).toEqual([join(home, '.demo')])

    const needs = result.agents[1]
    expect(needs?.variants[0]?.adoptable).toBe(false)
    expect(needs?.variants[0]?.missingRequires[0]).toContain('demo-adapter')
  })
})
