import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedBrain } from '../../src/brain/scripted-brain'
import type {
  BrainAction,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
} from '../../src/brain/types'
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
    expect(result.decisions).toHaveLength(3)
    expect(result.decisions.map((item) => item.type)).toEqual([
      'decompose',
      'select_agent',
      'accept_result',
    ])
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
    expect(executions.n).toBe(6)
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

class TwoTaskBrain implements OrchestratorBrain {
  async step(input: BrainInput): Promise<BrainAction[]> {
    const subtasks = input.tasks.flatMap((task) => task.subtasks)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [
            { title: 'first', description: 'first', requiredCapabilities: [] },
            { title: 'second', description: 'second', requiredCapabilities: [] },
          ],
          reason: 'two subtasks',
        },
      ]
    }
    return [
      ...subtasks
        .filter((subtask) => subtask.status === 'succeeded')
        .map(
          (subtask): BrainAction => ({
            type: 'accept',
            subtaskId: subtask.id,
            rationale: 'done',
          }),
        ),
      { type: 'finish', summary: 'done' },
    ]
  }

  async explain(input: BrainInput): Promise<DecisionRationale[]> {
    return [{ type: 'decompose', rationale: input.tasks.length === 0 ? 'two subtasks' : 'done' }]
  }
}

describe('runGoalWithBrain：多子任务', () => {
  it('执行 revise_plan 的全部子任务，而不是只跑第一个', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new MockProvider(),
      brain: new TwoTaskBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: 'two subtasks',
      worktree: dir,
      checks: [
        { kind: 'command', cmd: 'true', timeoutMs: 5_000, expect: { exitCode: 0 } },
        { kind: 'diffScope', allowedPaths: ['.'] },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.executions).toHaveLength(2)
    const subtasks = db
      .prepare('SELECT status FROM subtasks WHERE task_id = ? ORDER BY id')
      .all(result.taskId) as Array<{ status: string }>
    expect(subtasks.map((item) => item.status)).toEqual(['succeeded', 'succeeded'])
  })
})

class HumanBrain implements OrchestratorBrain {
  async step(): Promise<BrainAction[]> {
    return [
      {
        type: 'revise_plan',
        subtasks: [{ title: 'need input', description: 'need input', requiredCapabilities: [] }],
        reason: 'plan',
      },
      { type: 'request_human', kind: 'decide', question: '继续吗？', options: ['继续', '停止'] },
    ]
  }
  async explain(): Promise<DecisionRationale[]> {
    return [{ type: 'decompose', rationale: 'need input' }]
  }
}

class DelegateBrain implements OrchestratorBrain {
  async step(input: BrainInput): Promise<BrainAction[]> {
    const subtasks = input.tasks.flatMap((task) => task.subtasks)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [
            { title: 'first', description: 'first', requiredCapabilities: [] },
            { title: 'second', description: 'second', requiredCapabilities: [] },
          ],
          reason: 'two',
        },
      ]
    }
    const succeeded = subtasks.filter((subtask) => subtask.status === 'succeeded')
    if (succeeded.length === 0) {
      const first = subtasks.find((subtask) => subtask.status === 'ready')
      return first === undefined
        ? []
        : [{ type: 'delegate', request: { subtaskId: first.id, objective: first.description } }]
    }
    return [{ type: 'request_human', question: '还要继续第二个吗？' }]
  }
  async explain(): Promise<DecisionRationale[]> {
    return []
  }
}

class CancelBrain implements OrchestratorBrain {
  async step(input: BrainInput): Promise<BrainAction[]> {
    const subtasks = input.tasks.flatMap((task) => task.subtasks)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [{ title: 'cancel me', description: 'cancel me', requiredCapabilities: [] }],
          reason: 'plan',
        },
      ]
    }
    const subtask = subtasks[0]
    if (subtask?.status === 'ready') {
      return [
        { type: 'delegate', request: { subtaskId: subtask.id, objective: subtask.description } },
      ]
    }
    const executionId = subtask?.execution?.id
    return executionId === undefined ? [] : [{ type: 'cancel', executionId, reason: 'stop' }]
  }
  async explain(): Promise<DecisionRationale[]> {
    return []
  }
}

describe('Brain actions：request_human / cancel', () => {
  it('request_human 创 Clarification 并把 Task 停在 waiting_input', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new MockProvider(),
      brain: new HumanBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: 'needs input',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.executions).toHaveLength(0)
    expect(result.clarification?.status).toBe('pending')
    expect(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as { status: string })
        .status,
    ).toBe('waiting_input')
  })

  it('cancel 取消 Task，不执行', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new MockProvider(),
      brain: new CancelBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: 'cancel',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.stopReason).toBe('canceled')
    expect(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get(result.taskId) as { status: string })
        .status,
    ).toBe('canceled')
  })
})

describe('Brain actions：delegate', () => {
  it('delegate 指定子任务后只执行它，后续 request_human 停住', async () => {
    const db = database()
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new MockProvider(),
      brain: new DelegateBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: 'delegate one',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.executions).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.clarification?.status).toBe('pending')
    const subtasks = db
      .prepare('SELECT status FROM subtasks WHERE task_id = ? ORDER BY id')
      .all(result.taskId) as Array<{ status: string }>
    expect(subtasks.map((item) => item.status)).toEqual(['succeeded', 'ready'])
  })
})

class SwitchProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    if (command === 'mock-acp') {
      return {
        argv: [process.execPath, mockAgent],
        env: { ...process.env, MOCK_ACP_DELAY_MS: '0', MOCK_ACP_ALWAYS_FAIL: '1' },
      }
    }
    if (command === 'mock-acp-alt') {
      return {
        argv: [process.execPath, mockAgent],
        env: { ...process.env, MOCK_ACP_DELAY_MS: '0' },
      }
    }
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

describe('Selection Engine：自动换 Agent', () => {
  it('同 Agent 重试耗尽后自动选择另一个 Agent 完成', async () => {
    const db = database()
    addAgent(db, { name: 'mock2', command: 'mock-acp-alt' })
    const dir = repo()
    const result = await runGoalWithBrain({
      db,
      provider: new SwitchProvider(),
      brain: new ScriptedBrain(),
      agent: resolveAgent(db, 'mock'),
      availableAgents: [resolveAgent(db, 'mock'), resolveAgent(db, 'mock2')],
      objective: 'switch agent',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.ok).toBe(true)
    const executions = db
      .prepare('SELECT agent_id, status FROM executions ORDER BY created_at ASC')
      .all() as Array<{ agent_id: string; status: string }>
    expect(executions.map((item) => item.status)).toEqual(['failed', 'failed', 'succeeded'])
    expect(executions[2]?.agent_id).not.toBe(executions[0]?.agent_id)
  })
})

describe('M8：自动重规划', () => {
  it('换 Agent 无候选时创建新计划，最多 2 次后失败', async () => {
    const db = database()
    const dir = repo()
    const provider = new MockProvider()
    provider.env = { ...process.env, MOCK_ACP_DELAY_MS: '0', MOCK_ACP_ALWAYS_FAIL: '1' }
    const result = await runGoalWithBrain({
      db,
      provider,
      brain: new ScriptedBrain(),
      agent: resolveAgent(db, 'mock'),
      objective: 'replan',
      worktree: dir,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
    })
    expect(result.ok).toBe(false)
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(tasks.n).toBe(3)
    const executions = db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    expect(executions.n).toBe(6)
    expect(
      (db.prepare('SELECT status FROM goals WHERE id = ?').get(result.goalId) as { status: string })
        .status,
    ).toBe('failed')
  })
})
