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
    if (command === 'mock-acp') {
      return { argv: [process.execPath, mockAgent], env: this.env }
    }
    return { argv: ['/bin/bash', '-c', command], env: this.env }
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
      checks: [
        { kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } },
        { kind: 'diffScope', allowedPaths: ['.'] },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.stopReason).toBe('end_turn')
    expect(result.verdict).toBe('pass')
    expect(result.verification?.verdict).toBe('pass')
    expect(result.evidence.branch).toBeTruthy()
    expect(result.evidence.commitSha).toBeTruthy()
    expect(result.evidence.changedFiles).toContain('mock-output.txt')
    expect(result.evidence.diffstat).toContain('mock-output.txt')
    expect(result.evidence.diff).toContain('diff --git')
    expect(result.evidence.diff).toContain('mock-output.txt')
    expect(result.evidence.diffTruncated).toBeUndefined()
    expect(result.evidence.transcriptRef).toBe(result.transcriptRef)
    /* Agent 的最终回答进证据：只读任务的产物就是这段文字，Brain 靠它做后续判断。 */
    expect(result.evidence.result).toContain('mock agent working')
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

    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as {
      status: string
    }
    expect(task.status).toBe('running')
    const subtask = db
      .prepare('SELECT status FROM subtasks WHERE id = ?')
      .get(result.subtaskId) as { status: string }
    expect(subtask.status).toBe('succeeded')
  })
})

describe('runAcpTask：验收失败（TC-009 / TC-008）', () => {
  it('TC-009：Agent 返回 end_turn，但构建检查失败 -> fail', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider({ ...process.env, MOCK_ACP_DELAY_MS: '0' })

    const result = await runAcpTask({
      db,
      provider,
      agent: resolveAgent(db, 'mock'),
      objective: '自述成功但构建失败',
      worktree: dir,
      transcriptDir: join(dir, '.transcripts'),
      checks: [
        { kind: 'command', cmd: 'exit 1', timeoutMs: 5_000, expect: { exitCode: 0 } },
        { kind: 'diffScope', allowedPaths: ['.'] },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.verdict).toBe('fail')
    expect(result.verification?.checks[0]?.exitCode).toBe(1)
    expect(result.verification?.checks[0]?.passed).toBe(false)

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(result.executionId) as { status: string }
    expect(execution.status).toBe('failed')
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as {
      status: string
    }
    expect(task.status).toBe('failed')
  })

  it('TC-008：改动 CI 配置超出 allowedPaths -> diffScope fail', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider({
      ...process.env,
      MOCK_ACP_DELAY_MS: '0',
      MOCK_ACP_WRITE_PATH: '.github/workflows/ci.yml',
    })

    const result = await runAcpTask({
      db,
      provider,
      agent: resolveAgent(db, 'mock'),
      objective: '顺便改 CI 配置',
      worktree: dir,
      transcriptDir: join(dir, '.transcripts'),
      checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
    })

    expect(result.verdict).toBe('fail')
    expect(result.evidence.changedFiles).toContain('.github/workflows/ci.yml')
    expect(result.verification?.checks[0]?.kind).toBe('diffScope')
    expect(result.verification?.checks[0]?.passed).toBe(false)
  })
})

describe('runAcpTask：sandbox_denied -> Approval', () => {
  it('验收命令被沙箱拒绝 -> 生成 pending Approval，任务 waiting_approval', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider({ ...process.env, MOCK_ACP_DELAY_MS: '0' })

    const result = await runAcpTask({
      db,
      provider,
      agent: resolveAgent(db, 'mock'),
      objective: '需要越界写的验收',
      worktree: dir,
      transcriptDir: join(dir, '.transcripts'),
      checks: [
        {
          kind: 'command',
          cmd: "printf 'Operation not permitted' >&2; exit 1",
          timeoutMs: 5_000,
          expect: { exitCode: 0 },
        },
      ],
    })

    expect(result.verdict).toBe('fail')
    expect(result.approval?.reason).toBe('sandbox_denied')
    expect(result.approval?.status).toBe('pending')
    expect(result.approval?.decisionMode).toBe('once')

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(result.executionId) as { status: string }
    expect(execution.status).toBe('waiting_permission')
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as {
      status: string
    }
    expect(task.status).toBe('waiting_approval')
    const approval = db
      .prepare('SELECT status FROM approvals WHERE id = ?')
      .get(result.approval?.id) as { status: string }
    expect(approval.status).toBe('pending')
  })
})

describe('runAcpTask：失败与零写', () => {
  it('read-only 档：变更类工具被拒，execution/task/subtask 收敛为 failed', async () => {
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
      permissionMode: 'read-only',
    })

    expect(result.ok).toBe(false)
    /* Agent 自己的停止原因保真；权限被拒另用标记表达。 */
    expect(result.stopReason).toBe('refusal')
    expect(result.permissionDenied).toBe(true)
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

  it('workspace-write 档：Agent 请求权限时自动放行，任务正常完成', async () => {
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
      objective: '写个文件',
      worktree: dir,
      transcriptDir: join(dir, '.transcripts'),
      permissionMode: 'workspace-write',
      checks: [{ kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } }],
    })

    /* 关键回归：以前没接权限 handler → 一律拒绝 → 一条无害的写也被当成失败。 */
    expect(result.ok).toBe(true)
    expect(result.stopReason).toBe('end_turn')
    expect(result.permissionDenied).toBeUndefined()
    expect(existsSync(join(dir, 'mock-output.txt'))).toBe(true)
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
