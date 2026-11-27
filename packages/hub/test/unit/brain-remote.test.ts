import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteAgentClient } from '../../src/adapters/a2a/client'
import type {
  BrainAction,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
  RemotePeerSummary,
} from '../../src/brain/types'
import { DEFAULT_BRAIN_BUDGET } from '../../src/brain/types'
import { validateBrainActions } from '../../src/brain/validate'
import { addAgent } from '../../src/runtime/agent-registry'
import { runGoalWithBrain } from '../../src/runtime/brain-run'
import { listDispatches } from '../../src/runtime/dispatch/queue'
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
    throw new Error('stub provider 不该被调用（本用例不该跑本地 ACP）')
  },
  async dispose(): Promise<void> {},
} as unknown as SandboxProvider

function brainInput(peers?: readonly RemotePeerSummary[]): BrainInput {
  return {
    goal: { id: 'g1', title: '目标', intent: '意图', status: 'active' },
    planRevision: 1,
    tasks: [
      {
        id: 't1',
        title: '任务',
        status: 'running',
        subtasks: [
          { id: 's1', title: '子任务', description: '做点事', status: 'ready', required: true },
        ],
      },
    ],
    agents: [{ id: 'a1', name: 'A', status: 'idle' }],
    ...(peers === undefined ? {} : { peers }),
    pending: [],
    approvals: [],
    budget: DEFAULT_BRAIN_BUDGET,
    stateVersion: 1,
  }
}

const delegateWith = (request: { agentId?: string; peerId?: string }): BrainAction => ({
  type: 'delegate',
  request: { subtaskId: 's1', objective: '做点事', ...request },
})

describe('delegate 契约：远程目标', () => {
  const peers: RemotePeerSummary[] = [{ id: 'peer-b', displayName: 'B 机器' }]

  it('已知 peerId 通过校验', () => {
    const result = validateBrainActions(
      brainInput(peers),
      [delegateWith({ peerId: 'peer-b' })],
      DEFAULT_BRAIN_BUDGET,
    )
    expect(result.errors).toEqual([])
    expect(result.actions).toHaveLength(1)
  })

  it('未知 peerId 被拒（不退回本地 Agent）', () => {
    const result = validateBrainActions(
      brainInput(peers),
      [delegateWith({ peerId: 'peer-ghost' })],
      DEFAULT_BRAIN_BUDGET,
    )
    expect(result.ok).toBe(false)
    expect(result.actions).toHaveLength(0)
    expect(result.errors[0]?.message).toContain('未知远程对端')
  })

  it('未配置任何 peer 时，带 peerId 一律被拒', () => {
    const result = validateBrainActions(
      brainInput(),
      [delegateWith({ peerId: 'peer-b' })],
      DEFAULT_BRAIN_BUDGET,
    )
    expect(result.ok).toBe(false)
    expect(result.actions).toHaveLength(0)
  })

  it('agentId 与 peerId 只能二选一', () => {
    const result = validateBrainActions(
      brainInput(peers),
      [delegateWith({ agentId: 'a1', peerId: 'peer-b' })],
      DEFAULT_BRAIN_BUDGET,
    )
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('只能二选一')
  })
})

/** 先拆一个子任务，再把子任务委托给远程对端。 */
class RemoteFirstBrain implements OrchestratorBrain {
  readonly seenPeerIds: string[][] = []

  async step(input: BrainInput): Promise<BrainAction[]> {
    this.seenPeerIds.push((input.peers ?? []).map((peer) => peer.id))
    const subtasks = input.tasks.flatMap((task) => task.subtasks)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [
            {
              title: '远程计算',
              description: '让对端算这手牌',
              requiredCapabilities: [],
              maxAttempts: 1,
            },
          ],
          reason: '拆一个适合远程做的子任务',
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
    return [{ type: 'finish', summary: '没有待办' }]
  }

  async explain(): Promise<DecisionRationale[]> {
    return [{ type: 'select_agent', rationale: '这个子任务适合交给远程对端' }]
  }
}

interface SendRecord {
  text: string
  messageId?: string
}

function recordingConnect() {
  const sends: SendRecord[] = []
  const connect = async (): Promise<RemoteAgentClient> => ({
    card: async () => {
      throw new Error('card 不该被调用')
    },
    send: async (input) => {
      sends.push(input)
      return { taskId: 'rt-remote-1', contextId: 'ctx-remote', state: 1 }
    },
    get: async () => {
      throw new Error('brain 回合不该轮询远端')
    },
    cancel: async () => {
      throw new Error('brain 回合不该取消远端')
    },
  })
  return { sends, connect }
}

describe('Brain 选远程目标：runtime 只提交不阻塞', () => {
  it('delegate 带 peerId 时落远程派发意图并提交，回合以 waiting_remote 结束', async () => {
    const database = db()
    const agent = addAgent(database, { name: 'mock', command: 'mock-acp' })
    const brain = new RemoteFirstBrain()
    const { sends, connect } = recordingConnect()

    const result = await runGoalWithBrain({
      db: database,
      provider: stubProvider,
      agent,
      objective: '让对端算这手牌',
      worktree: '/tmp',
      brain,
      remote: {
        peers: [{ id: 'peer-b', displayName: 'B 机器' }],
        resolvePeer: () => ({ url: 'https://b.example', token: 'tok' }),
        connect,
      },
    })

    /* 只提交一次，且不等结果。 */
    expect(sends).toHaveLength(1)
    expect(sends[0]?.text).toBe('让对端算这手牌')
    expect(result.ok).toBe(false)
    expect(result.stopReason).toBe('waiting_remote')
    expect(result.executions).toEqual([])

    /* 意图与关联都落库（重启后不依赖内存）。 */
    const intents = listDispatches(database, result.goalId)
    expect(intents).toHaveLength(1)
    expect(intents[0]?.target).toBe('remote-a2a')
    expect(intents[0]?.status).toBe('done')
    expect(intents[0]?.payload).toEqual({ peerId: 'peer-b' })

    const refs = listRemoteTasks(database, result.goalId)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.remoteTaskId).toBe('rt-remote-1')
    /* 提交时就已经建好本地 Execution 并回填关联：Brain 快照里能看见这条子任务。 */
    expect(refs[0]?.localExecutionId).toBeDefined()
    const execution = database
      .prepare('SELECT status, agent_id FROM executions WHERE id = ?')
      .get(refs[0]?.localExecutionId) as { status: string; agent_id: string } | undefined
    expect(execution?.status).toBe('running')
    expect(execution?.agent_id).toBe('remote:peer-b')
    expect(
      findRemoteTaskByIdempotencyKey(database, intents[0]?.idempotencyKey ?? '')?.observedState,
    ).toBe('submitted')

    /* Brain 快照里确实带上了 peer，否则它不可能选出来。 */
    expect(brain.seenPeerIds[0]).toContain('peer-b')
  })

  it('未配置 remote 时，Brain 指定 peerId 会被拒且不静默改成本地执行', async () => {
    const database = db()
    const agent = addAgent(database, { name: 'mock', command: 'mock-acp' })
    const brain = new RemoteFirstBrain()

    await expect(
      runGoalWithBrain({
        db: database,
        provider: stubProvider,
        agent,
        objective: '让对端算这手牌',
        worktree: '/tmp',
        brain,
      }),
    ).rejects.toThrow()

    /* 既没有远程意图，也没有本地意图：拒绝就是拒绝。 */
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM dispatch_queue').get() as { n: number }).n,
    ).toBe(0)
  })
})
