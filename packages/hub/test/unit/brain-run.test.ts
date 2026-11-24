import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedBrain } from '../../src/brain/scripted-brain'
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
  env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = { ...process.env, MOCK_ACP_DELAY_MS: '0' }) {
    this.env = env
  }

  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    if (command === 'mock-acp') {
      return {
        argv: [process.execPath, mockAgent],
        env: this.env,
      }
    }
    return { argv: ['/bin/bash', '-c', command], env: this.env }
  }

  async dispose(): Promise<void> {}
}

describe('runGoalWithBrain', () => {
  it('Goal → 拆计划 → 委派 → 验收 → accept/finish，产出 DecisionRecord', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      brain: new ScriptedBrain(),
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

describe('runGoalWithBrain：M8 自动重试', () => {
  it('首次 refusal 且无 diff -> 同 Agent 重试后成功', async () => {
    const db = database()
    const dir = repo()
    const marker = mkdtempSync(join(tmpdir(), 'hubagent-retry-')) + '/failed-once'
    const provider = new MockProvider()
    provider.env = {
      ...process.env,
      MOCK_ACP_DELAY_MS: '0',
      MOCK_ACP_FAIL_FIRST_FILE: marker,
    }
    const result = await runGoalWithBrain({
      db,
      provider,
      brain: new ScriptedBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: '第一次失败，第二次成功',
      worktree: dir,
      checks: [
        { kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } },
        { kind: 'diffScope', allowedPaths: ['.'] },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.verdict).toBe('pass')
    const executions = db
      .prepare('SELECT status, attempt FROM executions ORDER BY attempt ASC')
      .all() as Array<{ status: string; attempt: number }>
    expect(executions.map((item) => item.status)).toEqual(['failed', 'succeeded'])
    expect(executions.map((item) => item.attempt)).toEqual([1, 2])
  })

  it('持续失败 -> 只重试一次，最终 Task/Goal failed', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_DELAY_MS: '0', MOCK_ACP_ALWAYS_FAIL: '1' }
    const result = await runGoalWithBrain({
      db,
      provider,
      brain: new ScriptedBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: '持续失败',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.ok).toBe(false)
    const executions = db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    expect(executions.n).toBe(2)
    expect(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as { status: string })
        .status,
    ).toBe('failed')
    expect(
      (db.prepare('SELECT status FROM goals WHERE id = ?').get(result.goalId) as { status: string })
        .status,
    ).toBe('failed')
  })
})
