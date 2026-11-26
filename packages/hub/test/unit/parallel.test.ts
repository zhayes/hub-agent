import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { addAgent, resolveAgent } from '../../src/runtime/agent-registry'
import { runParallelAgents } from '../../src/runtime/workspace/parallel'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const mockAgent = fileURLToPath(new URL('../fixtures/acp/mock-agent.mjs', import.meta.url))
const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-parallel-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'],
    { cwd: dir },
  )
  return dir
}

function database(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  addAgent(db, { name: 'mock', command: 'mock-acp' })
  addAgent(db, { name: 'mock2', command: 'mock-acp' })
  return db
}

class MockProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, spec: SandboxSpec): Promise<SandboxedCommand> {
    if (command.startsWith('mock-acp')) {
      /* 两个 agent 各写各的文件，否则合并阶段必然冲突（不是本次要验证的东西）。 */
      const tag = basename(spec.cwd).replace(/[^a-zA-Z0-9]/g, '')
      return {
        argv: [process.execPath, mockAgent],
        env: {
          ...process.env,
          MOCK_ACP_DELAY_MS: '0',
          MOCK_ACP_WRITE_PATH: `out-${tag}.txt`,
        },
      }
    }
    return { argv: ['/bin/bash', '-c', command], env: process.env }
  }

  async dispose(): Promise<void> {}
}

describe('runParallelAgents：走统一派发入口', () => {
  it('每个子任务都产生一条派发意图，并最终合并成功', async () => {
    const db = database()
    const result = await runParallelAgents({
      db,
      provider: new MockProvider(),
      agents: [resolveAgent(db, 'mock'), resolveAgent(db, 'mock2')],
      objective: '写 a.txt，同时写 b.txt',
      repoRoot: repo(),
      checks: [{ kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } }],
      clientVersion: 'test',
    })

    expect(result.ok).toBe(true)
    expect(result.subtasks).toHaveLength(2)

    /* 关键：并行编排也要留下可对账的持久化意图，而不是只存在于内存里。 */
    const intents = db
      .prepare('SELECT status, target, execution_id FROM dispatch_queue ORDER BY created_at ASC')
      .all() as Array<{ status: string; target: string; execution_id: string | null }>
    expect(intents).toHaveLength(2)
    expect(intents.every((item) => item.status === 'done')).toBe(true)
    expect(intents.every((item) => item.target === 'local-acp')).toBe(true)

    /* 意图里的 executionId 必须与 worktree 租约固定的一致。 */
    const executionIds = new Set(result.subtasks.map((item) => item.executionId))
    expect(intents.map((item) => item.execution_id).sort()).toEqual([...executionIds].sort())
  })
})
