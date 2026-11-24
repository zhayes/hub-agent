import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runAcpTask } from '../../src/runtime/acp-run'
import { addAgent, resolveAgent } from '../../src/runtime/agent-registry'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { HubError } from '../../src/shared/errors'
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
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-run-'))
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
  error: unknown

  constructor(env: NodeJS.ProcessEnv = { ...process.env }) {
    this.env = env
  }

  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    if (this.error !== undefined) throw this.error
    if (command.startsWith('git ')) {
      return { argv: ['/bin/bash', '-c', command], env: this.env }
    }
    return { argv: [process.execPath, mockAgent], env: this.env }
  }

  async dispose(): Promise<void> {}
}

describe('runAcpTask：成功链路', () => {
  it('prompt 成功，产出 branch/commitSha/diffstat/changedFiles 与 transcript', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider({ ...process.env, MOCK_ACP_DELAY_MS: '0' })
    const transcriptDir = join(dir, '.transcripts')

    const result = await runAcpTask({
      db,
      provider,
      agent: resolveAgent(db, 'mock'),
      objective: '写一个 mock-output.txt 并提交',
      worktree: dir,
      transcriptDir,
    })

    expect(result.ok).toBe(true)
    expect(result.stopReason).toBe('end_turn')
    expect(result.evidence.branch).toBeTruthy()
    expect(result.evidence.commitSha).toBeTruthy()
    expect(result.evidence.changedFiles).toContain('mock-output.txt')
    expect(result.evidence.diffstat).toContain('mock-output.txt')
    expect(result.evidence.transcriptRef).toBe(result.transcriptRef)
    expect(existsSync(result.transcriptRef)).toBe(true)
    expect(result.updates).toBeGreaterThan(0)

    const transcript = readFileSync(result.transcriptRef, 'utf8')
    expect(transcript).toContain('run.started')
    expect(transcript).toContain('message.delta')
    expect(transcript).toContain('tool.call')

    const execution = db
      .prepare('SELECT status, session_id FROM executions WHERE id = ?')
      .get(result.executionId) as { status: string; session_id: string }
    expect(execution.status).toBe('succeeded')
    expect(execution.session_id).toBe(result.sessionId)

    // M5 之前不伪造 subtask/task 成功：验收证据链还没接。
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as {
      status: string
    }
    expect(task.status).toBe('running')
  })
})

describe('runAcpTask：失败与零写', () => {
  it('prompt 被拒绝后 execution/task/subtask 收敛为 failed', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider({
      ...process.env,
      MOCK_ACP_DELAY_MS: '0',
      MOCK_ACP_REQUEST_PERMISSION: '1',
    })

    const result = await runAcpTask({
      db,
      provider,
      agent: resolveAgent(db, 'mock'),
      objective: '需要权限的任务',
      worktree: dir,
      transcriptDir: join(dir, '.transcripts'),
    })

    expect(result.ok).toBe(false)
    expect(result.stopReason).toBe('refusal')
    expect(existsSync(join(dir, 'mock-output.txt'))).toBe(false)

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(result.executionId) as { status: string }
    expect(execution.status).toBe('failed')
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as {
      status: string
    }
    expect(task.status).toBe('failed')
  })

  it('沙箱拒绝启动时零任务记录（fail-closed 语义边界）', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider()
    provider.error = new HubError('SANDBOX_UNAVAILABLE', 'no srt')

    await expect(
      runAcpTask({
        db,
        provider,
        agent: resolveAgent(db, 'mock'),
        objective: '不会开始的任务',
        worktree: dir,
        transcriptDir: join(dir, '.transcripts'),
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })

    for (const table of ['goals', 'tasks', 'subtasks', 'executions']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      expect(row.n).toBe(0)
    }
  })
})
