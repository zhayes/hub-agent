import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { addAgent, resolveAgent } from '../../src/runtime/agent-registry'
import { runGoalWithBrain } from '../../src/runtime/brain-run'
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
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-brain-run-'))
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
  return db
}

class MockProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    if (command === 'mock-acp') {
      return {
        argv: [process.execPath, mockAgent],
        env: { ...process.env, MOCK_ACP_DELAY_MS: '0' },
      }
    }
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

describe('runGoalWithBrain', () => {
  it('Goal → 拆计划 → 委派 → 验收 → accept/finish，产出 DecisionRecord', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new MockProvider(),
      agent: resolveAgent(db, 'mock'),
      objective: '写 mock-output.txt 并验收',
      worktree: dir,
      checks: [
        { kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } },
        { kind: 'diffScope', allowedPaths: ['.'] },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.verdict).toBe('pass')
    expect(result.decisions).toHaveLength(2)
    expect(result.decisions[0]?.type).toBe('decompose')
    expect(result.decisions[1]?.type).toBe('accept_result')
    expect(result.decisions[0]?.rationale.length).toBeGreaterThan(0)

    const task = db
      .prepare('SELECT status, goal_id FROM tasks WHERE id = ?')
      .get(result.taskId) as {
      status: string
      goal_id: string
    }
    expect(task.status).toBe('running')
    expect(task.goal_id).toBe(result.goalId)
  })
})
