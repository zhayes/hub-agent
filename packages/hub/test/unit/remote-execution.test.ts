import type { Task } from '@a2a-js/sdk'
import { TaskState } from '@a2a-js/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteAgentClient } from '../../src/adapters/a2a/client'
import type {
  BrainAction,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
} from '../../src/brain/types'
import { addAgent } from '../../src/runtime/agent-registry'
import { runGoalWithBrain } from '../../src/runtime/brain-run'
import { listClarifications } from '../../src/runtime/clarify'
import { listRemoteArtifacts } from '../../src/runtime/remote-artifact'
import {
  mapRemoteStateToExecution,
  settleRemoteExecution,
} from '../../src/runtime/remote-execution'
import { reconcileRemoteTasks } from '../../src/runtime/remote-reconcile'
import { findRemoteTaskByIdempotencyKey, listRemoteTasks } from '../../src/runtime/remote-task'
import type { SandboxDescription, SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

const stubProvider = {
  describe: (): SandboxDescription => ({
    kind: 'srt',
    platform: process.platform,
    ready: true,
    detail: 'test',
  }),
  async wrap(): Promise<never> {
    throw new Error('stub provider 不该被调用')
  },
  async dispose(): Promise<void> {},
} as unknown as SandboxProvider

class RemoteBrain implements OrchestratorBrain {
  async step(input: BrainInput): Promise<BrainAction[]> {
    const subtasks = input.tasks.flatMap((task) => task.subtasks)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [
            { title: '远程分析', description: '让对端分析日志', requiredCapabilities: [] },
          ],
          reason: '拆一个远程子任务',
        },
      ]
    }
    const ready = subtasks.find((subtask) => subtask.status === 'ready')
    if (ready !== undefined) {
      return [
        {
          type: 'delegate',
          request: { subtaskId: ready.id, objective: ready.description, peerId: 'peer-b' },
        },
      ]
    }
    return [{ type: 'finish', summary: '无事可做' }]
  }

  async explain(): Promise<DecisionRationale[]> {
    return [{ type: 'select_agent', rationale: '交给远程对端' }]
  }
}

const peerEndpoint = { url: 'https://b.example', token: 'tok' }

function sendConnect(): () => Promise<RemoteAgentClient> {
  return async () => ({
    card: async () => {
      throw new Error('unused')
    },
    send: async () => ({ taskId: 'rt-1', contextId: 'ctx-1', state: TaskState.TASK_STATE_WORKING }),
    get: async () => {
      throw new Error('unused')
    },
    cancel: async () => {
      throw new Error('unused')
    },
  })
}

function taskWith(state: TaskState, artifacts: readonly unknown[] = []): Task {
  return {
    id: 'rt-1',
    contextId: 'ctx-1',
    status: { state, message: undefined, timestamp: 'ts-2' },
    artifacts: [...artifacts],
    history: [],
    metadata: {},
  } as unknown as Task
}

/** 跑一次 Brain 远程委托，返回 goalId（此时 ref 与本地 Execution 都已就绪）。 */
async function submittedGoal(database: Db): Promise<string> {
  await runGoalWithBrain({
    db: database,
    provider: stubProvider,
    agent: addAgent(database, { name: 'mock', command: 'mock-acp' }),
    objective: '让对端分析日志',
    worktree: '/tmp',
    brain: new RemoteBrain(),
    remote: {
      peers: [{ id: 'peer-b', displayName: 'B' }],
      resolvePeer: () => peerEndpoint,
      connect: sendConnect(),
    },
  })
  const rows = database
    .prepare('SELECT DISTINCT goal_id AS goalId FROM remote_task_refs')
    .all() as Array<{ goalId: string }>
  const goalId = rows[0]?.goalId
  if (goalId === undefined) throw new Error('没有产生远端关联')
  return goalId
}

function executionOf(database: Db, executionId: string | undefined) {
  return database
    .prepare('SELECT status, agent_id, evidence FROM executions WHERE id = ?')
    .get(executionId) as { status: string; agent_id: string; evidence: string | null } | undefined
}

describe('远端观测 → 本地 Execution 状态（PRD §7.6.1）', () => {
  it('映射表与 PRD 出站列一致', () => {
    expect(mapRemoteStateToExecution('submitted')).toBe('running')
    expect(mapRemoteStateToExecution('working')).toBe('running')
    expect(mapRemoteStateToExecution('input_required')).toBe('waiting_input')
    expect(mapRemoteStateToExecution('auth_required')).toBe('waiting_permission')
    expect(mapRemoteStateToExecution('failed')).toBe('failed')
    expect(mapRemoteStateToExecution('rejected')).toBe('failed')
    expect(mapRemoteStateToExecution('canceled')).toBe('canceled')
    expect(mapRemoteStateToExecution('unknown')).toBe('unknown')
    // completed 必须先过本地验收，不能直接 succeeded
    expect(mapRemoteStateToExecution('completed')).toBe('running')
  })
})

describe('远端完成：不采信自述，先本地验收', () => {
  it('没有验收器时判 manual_required，Execution 停在 waiting_input', async () => {
    const database = db()
    const goalId = await submittedGoal(database)
    const ref = listRemoteTasks(database, goalId)[0]
    expect(ref?.localExecutionId).toBeDefined()

    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => peerEndpoint,
      connect: async () => ({
        card: async () => {
          throw new Error('unused')
        },
        send: async () => {
          throw new Error('对账不得重发')
        },
        get: async () =>
          taskWith(TaskState.TASK_STATE_COMPLETED, [
            {
              artifactId: 'art-1',
              parts: [{ content: { $case: 'text', value: 'diff --git a/x b/x' } }],
              metadata: {},
            },
            {
              artifactId: 'art-2',
              parts: [{ content: { $case: 'text', value: '结论：日志正常' } }],
              metadata: {},
            },
          ]),
        cancel: async () => {
          throw new Error('unused')
        },
      }),
      staleAfterMs: 0,
    })
    expect(report.terminal).toEqual([ref?.id])

    const execution = executionOf(database, ref?.localExecutionId)
    expect(execution?.status).toBe('waiting_input')
    /* 证据只记录“收到了什么”，不代表通过验收；成功与否看 status/verdict。 */
    expect(execution?.evidence).toContain('a2a:peer-b/rt-1')

    const run = database
      .prepare('SELECT verdict FROM verification_runs WHERE execution_id = ?')
      .get(ref?.localExecutionId) as { verdict: string } | undefined
    expect(run?.verdict).toBe('manual_required')

    /* 交付物 manifest：diff 内容识别为 patch，纯文本识别为 analysis。 */
    const artifacts = listRemoteArtifacts(database, ref?.id ?? '')
    expect(artifacts.map((artifact) => `${artifact.artifactId}:${artifact.form}`)).toEqual([
      'art-1:patch',
      'art-2:analysis',
    ])
    expect(artifacts.every((artifact) => artifact.signerPeerId === 'peer-b')).toBe(true)

    /* 子任务与 Task 一起停在 waiting_input，避免被当成“已完成”。 */
    const subtask = database
      .prepare('SELECT status FROM subtasks WHERE id = ?')
      .get(ref?.subtaskId) as { status: string } | undefined
    expect(subtask?.status).toBe('waiting_input')

    /* 留了一条可操作的人工验收入口：选项就是 accept / reject。 */
    const clarifications = listClarifications(database, goalId)
    expect(clarifications).toHaveLength(1)
    expect(clarifications[0]?.options).toEqual(['accept', 'reject'])
    expect(clarifications[0]?.executionId).toBe(ref?.localExecutionId)
    expect(clarifications[0]?.kind).toBe('decide')
  })

  it('验收通过（带可执行检查）才置 succeeded，并留下证据', async () => {
    const database = db()
    const goalId = await submittedGoal(database)
    const ref = listRemoteTasks(database, goalId)[0]
    expect(ref).toBeDefined()
    if (ref === undefined) return

    settleRemoteExecution(database, {
      ref,
      observed: 'completed',
      artifacts: [{ artifactId: 'art-1', form: 'analysis' }],
      verify: () => ({
        verdict: 'pass',
        checks: [
          {
            checkId: 'check-1',
            kind: 'command',
            passed: true,
            command: 'true',
            exitCode: 0,
            outputRef: '/tmp/check-1.log',
            durationMs: 1,
          },
        ],
      }),
    })

    const execution = executionOf(database, ref.localExecutionId)
    expect(execution?.status).toBe('succeeded')
    expect(execution?.evidence).toContain('a2a:peer-b/rt-1')

    const run = database
      .prepare('SELECT verdict FROM verification_runs WHERE execution_id = ?')
      .get(ref.localExecutionId) as { verdict: string } | undefined
    expect(run?.verdict).toBe('pass')

    const subtask = database
      .prepare('SELECT status FROM subtasks WHERE id = ?')
      .get(ref.subtaskId) as { status: string } | undefined
    expect(subtask?.status).toBe('succeeded')
  })

  it('没有可执行检查时不允许 pass（降级为 manual_required）', async () => {
    const database = db()
    const goalId = await submittedGoal(database)
    const ref = listRemoteTasks(database, goalId)[0]
    if (ref === undefined) throw new Error('缺少关联')

    settleRemoteExecution(database, {
      ref,
      observed: 'completed',
      verify: () => ({ verdict: 'pass', checks: [] }),
    })

    expect(executionOf(database, ref.localExecutionId)?.status).toBe('waiting_input')
  })
})

describe('对账钩子：本地验收结果决定是否成功', () => {
  it('verify 钩子返回 pass → Execution succeeded；钩子收到交付物', async () => {
    const database = db()
    const goalId = await submittedGoal(database)
    const ref = listRemoteTasks(database, goalId)[0]
    if (ref === undefined) throw new Error('缺少关联')

    const seen: string[] = []
    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => peerEndpoint,
      connect: async () => ({
        card: async () => {
          throw new Error('unused')
        },
        send: async () => {
          throw new Error('对账不得重发')
        },
        get: async () =>
          taskWith(TaskState.TASK_STATE_COMPLETED, [
            {
              artifactId: 'changes',
              parts: [{ content: { $case: 'text', value: 'diff --git a/x b/x' } }],
              metadata: { form: 'patch' },
            },
          ]),
        cancel: async () => {
          throw new Error('unused')
        },
      }),
      staleAfterMs: 0,
      verify: async ({ artifacts }) => {
        seen.push(...artifacts.map((artifact) => `${artifact.artifactId}:${artifact.form}`))
        return {
          verdict: 'pass',
          checks: [
            {
              checkId: 'check-1',
              kind: 'command',
              passed: true,
              command: 'true',
              exitCode: 0,
              outputRef: '/tmp/check-1.log',
              durationMs: 1,
            },
          ],
        }
      },
    })

    expect(report.terminal).toEqual([ref.id])
    expect(seen).toEqual(['changes:patch'])
    expect(executionOf(database, ref.localExecutionId)?.status).toBe('succeeded')
  })
})

describe('远端运行中：只推进状态，不产生验收', () => {
  it('working 保持 running，且不写 verification', async () => {
    const database = db()
    const goalId = await submittedGoal(database)
    const ref = listRemoteTasks(database, goalId)[0]
    if (ref === undefined) throw new Error('缺少关联')

    await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => peerEndpoint,
      connect: async () => ({
        card: async () => {
          throw new Error('unused')
        },
        send: async () => {
          throw new Error('unused')
        },
        get: async () => taskWith(TaskState.TASK_STATE_WORKING),
        cancel: async () => {
          throw new Error('unused')
        },
      }),
      staleAfterMs: 0,
    })

    expect(executionOf(database, ref.localExecutionId)?.status).toBe('running')
    expect(findRemoteTaskByIdempotencyKey(database, ref.idempotencyKey)?.observedState).toBe(
      'working',
    )
    const runs = database
      .prepare('SELECT COUNT(*) AS n FROM verification_runs WHERE execution_id = ?')
      .get(ref.localExecutionId) as { n: number }
    expect(runs.n).toBe(0)
  })
})
