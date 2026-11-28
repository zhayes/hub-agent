import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_RUN_SETTINGS, normalizeRunSettings } from '../../src/domain/chat'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  asVerificationRunId,
} from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { createHttpApp } from '../../src/interfaces/http/app'
import type { AgentRecord } from '../../src/runtime/agent-registry'
import { ChatService } from '../../src/runtime/chat/chat-service'
import { scopeAgents, verificationChecks } from '../../src/runtime/chat/run-settings'
import { deliverTask } from '../../src/runtime/workspace/deliver'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { createChatThread, getChatThread, updateChatThread } from '../../src/storage/queries/chat'
import { loadState } from '../../src/storage/queries/state'
import { appendEvent } from '../../src/storage/write/events'

const AT = asTimestamp('2026-11-27T10:00:00.000Z')
const dbs: Db[] = []
const dirs: string[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function freshDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  return db
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-home-'))
  dirs.push(dir)
  return dir
}

const agent = (name: string): AgentRecord =>
  ({ name, command: name, networkMode: 'agent-managed' }) as unknown as AgentRecord

describe('normalizeRunSettings', () => {
  it('默认值：不勾 Agent、不填命令', () => {
    expect(normalizeRunSettings(undefined)).toEqual(DEFAULT_RUN_SETTINGS)
    expect(normalizeRunSettings('nonsense')).toEqual(DEFAULT_RUN_SETTINGS)
    expect(normalizeRunSettings({ verifyCommands: 'not-an-array' })).toEqual(DEFAULT_RUN_SETTINGS)
  })

  it('命令去空、去重，坏值丢掉', () => {
    const settings = normalizeRunSettings({
      verifyCommands: ['  pnpm test:unit  ', '', '   ', 'pnpm test:unit', 42],
    })
    expect(settings.verifyCommands).toEqual(['pnpm test:unit'])
  })

  it('旧数据里的 budget 字段被忽略，不让会话变成不可用', () => {
    const settings = normalizeRunSettings({
      verifyCommands: ['pnpm test'],
      budget: { maxActions: 6 },
    })
    expect(settings).toEqual({ verifyCommands: ['pnpm test'], agents: [] })
  })
})

describe('run settings 落到运行时参数', () => {
  it('验收命令后面永远跟着 diffScope', () => {
    const checks = verificationChecks({
      verifyCommands: ['pnpm test:unit', 'pnpm lint'],
      agents: [],
    })
    expect(checks.map((check) => check.kind)).toEqual(['command', 'command', 'diffScope'])
    expect(checks[0]).toMatchObject({
      kind: 'command',
      cmd: 'pnpm test:unit',
      expect: { exitCode: 0 },
    })
  })

  it('没给命令时只剩 diffScope（证明不了任务做成了）', () => {
    const checks = verificationChecks(DEFAULT_RUN_SETTINGS)
    expect(checks).toHaveLength(1)
    expect(checks[0]?.kind).toBe('diffScope')
  })

  it('可用 Agent 是范围，不是勾选名单以外就禁用', () => {
    const all = [agent('Claude Code'), agent('Codex')]
    expect(scopeAgents(all, DEFAULT_RUN_SETTINGS).map((item) => item.name)).toEqual([
      'Claude Code',
      'Codex',
    ])
    expect(
      scopeAgents(all, { ...DEFAULT_RUN_SETTINGS, agents: ['Codex'] }).map((item) => item.name),
    ).toEqual(['Codex'])
  })
})

describe('chat_threads.run_settings', () => {
  it('写入后能原样读出，更新后覆盖', () => {
    const db = freshDb()
    const created = createChatThread(db, {
      title: 't',
      runSettings: { verifyCommands: ['pnpm test'], agents: ['Codex'] },
    })
    expect(getChatThread(db, created.id)?.runSettings).toEqual({
      verifyCommands: ['pnpm test'],
      agents: ['Codex'],
    })

    updateChatThread(db, created.id, { runSettings: DEFAULT_RUN_SETTINGS })
    expect(getChatThread(db, created.id)?.runSettings).toEqual(DEFAULT_RUN_SETTINGS)
  })

  it('库里存了坏 JSON 也不让会话变不可执行', () => {
    const db = freshDb()
    const created = createChatThread(db, { title: 't' })
    db.prepare('UPDATE chat_threads SET run_settings = ? WHERE id = ?').run('{broken', created.id)
    expect(getChatThread(db, created.id)?.runSettings).toEqual(DEFAULT_RUN_SETTINGS)
  })
})

function seedTask(db: Db, options: { verdict?: 'pass' | 'fail' } = {}): string {
  let state = appendEvent(db, emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('g1'),
      userId: 'local',
      title: 'goal',
      intent: 'goal',
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'task.created',
    task: {
      id: asTaskId('t1'),
      goalId: asGoalId('g1'),
      title: '修复重定向',
      description: 'task',
      status: 'draft',
      priority: 0,
      acceptanceCriteria: [],
      createdAt: AT,
      updatedAt: AT,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'subtask.created',
    subtask: {
      id: asSubtaskId('s1'),
      taskId: asTaskId('t1'),
      title: 'fix',
      description: 'fix',
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: [],
      priority: 0,
      maxAttempts: 2,
      createdAt: AT,
      updatedAt: AT,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'execution.created',
    execution: {
      id: asExecutionId('e1'),
      taskId: asTaskId('t1'),
      subtaskId: asSubtaskId('s1'),
      agentId: asAgentId('a1'),
      status: 'created',
      attempt: 1,
      createdAt: AT,
    },
  }).state
  appendEvent(db, state, {
    type: 'execution.evidence',
    executionId: asExecutionId('e1'),
    evidence: {
      branch: 'hubagent/e1',
      commitSha: 'abc123def456',
      diffstat: ' src/a.ts | 3 +-\n 1 file changed, 2 insertions(+), 1 deletion(-)',
      changedFiles: ['src/a.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n',
    },
  })
  if (options.verdict !== undefined) {
    appendEvent(db, loadState(db), {
      type: 'verification.recorded',
      run: {
        id: asVerificationRunId('v1'),
        executionId: asExecutionId('e1'),
        /* pass 必须带通过的可执行检查（不变量：验收不得自证）。 */
        checks: [
          {
            checkId: 'c1',
            kind: 'command',
            passed: options.verdict === 'pass',
            command: 'pnpm test:unit',
            exitCode: options.verdict === 'pass' ? 0 : 1,
          },
        ],
        verdict: options.verdict,
        decidedBy: 'runtime',
        createdAt: AT,
      },
    })
  }
  return 't1'
}

describe('deliverTask', () => {
  it('验收没通过（或还没有验收）就不给交付', () => {
    const db = freshDb()
    seedTask(db)
    expect(() => deliverTask(db, 't1', 'branch-only')).toThrow(/验收结论/)
  })

  it('验收未通过时拒绝', () => {
    const db = freshDb()
    seedTask(db, { verdict: 'fail' })
    expect(() => deliverTask(db, 't1', 'patch-export')).toThrow(/验收未通过/)
  })

  it('branch-only 只回报分支与提交，不写任何文件', () => {
    const db = freshDb()
    seedTask(db, { verdict: 'pass' })
    const result = deliverTask(db, 't1', 'branch-only')
    expect(result).toMatchObject({
      mode: 'branch-only',
      branch: 'hubagent/e1',
      files: 1,
      added: 2,
      removed: 1,
    })
    expect(result.patchRef).toBeUndefined()
  })

  it('patch-export 把补丁写到 artifacts 并回报路径', () => {
    const db = freshDb()
    seedTask(db, { verdict: 'pass' })
    process.env['HUBAGENT_HOME'] = home()
    try {
      const result = deliverTask(db, 't1', 'patch-export')
      expect(result.patchRef).toBeDefined()
      const path = result.patchRef ?? ''
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('diff --git a/src/a.ts')
      expect(result.added).toBe(2)
    } finally {
      delete process.env['HUBAGENT_HOME']
    }
  })
})

const providerStub = (): SandboxProvider =>
  ({
    describe: () => ({ kind: 'test' }),
    wrap: async () => {
      throw new Error('not used')
    },
    dispose: async () => undefined,
  }) as unknown as SandboxProvider

describe('HTTP：运行设置与交付', () => {
  const auth = { authorization: 'Bearer token', 'content-type': 'application/json' }

  it('建会话时就带上运行设置，PATCH 能改，坏字段退到默认', async () => {
    const db = freshDb()
    const chat = new ChatService({ db, provider: providerStub(), clientVersion: 'test' })
    const app = createHttpApp({ db, token: 'token', chat })

    const created = await app.request('/api/v1/chat/threads', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        title: 'T',
        worktree: home(),
        runSettings: {
          verifyCommands: ['pnpm test'],
          agents: ['Codex'],
        },
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      thread: {
        id: string
        runSettings: { verifyCommands: string[]; agents: string[] }
      }
    }
    expect(createdBody.thread.runSettings.verifyCommands).toEqual(['pnpm test'])
    expect(createdBody.thread.runSettings.agents).toEqual(['Codex'])

    const patched = await app.request(`/api/v1/chat/threads/${createdBody.thread.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ runSettings: { verifyCommands: ['x', 7], agents: 'bad' } }),
    })
    expect(patched.status).toBe(200)
    const patchedBody = (await patched.json()) as {
      thread: { runSettings: { verifyCommands: string[]; agents: string[] } }
    }
    expect(patchedBody.thread.runSettings).toEqual({
      verifyCommands: ['x'],
      agents: [],
    })
  })

  it('交付：patch-export 返回路径，auto-merge 不再是合法模式', async () => {
    const db = freshDb()
    seedTask(db, { verdict: 'pass' })
    const app = createHttpApp({ db, token: 'token' })
    process.env['HUBAGENT_HOME'] = home()
    try {
      const exported = await app.request('/api/v1/tasks/t1/deliver', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ mode: 'patch-export' }),
      })
      expect(exported.status).toBe(200)
      const body = (await exported.json()) as { delivery: { patchRef?: string; added: number } }
      expect(body.delivery.patchRef).toBeDefined()
      expect(body.delivery.added).toBe(2)

      const merged = await app.request('/api/v1/tasks/t1/deliver', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ mode: 'auto-merge' }),
      })
      expect(merged.status).toBe(400)
      expect(await merged.text()).toContain('branch-only')

      const invalid = await app.request('/api/v1/tasks/t1/deliver', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ mode: 'yolo' }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      delete process.env['HUBAGENT_HOME']
    }
  })
})
