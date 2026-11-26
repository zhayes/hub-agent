import { afterEach, describe, expect, it } from 'vitest'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { claimDispatch, enqueueDispatch, listDispatches } from '../../src/runtime/dispatch/queue'
import { deriveIdempotencyKey, reserveDelegation } from '../../src/runtime/recovery/idempotency'
import { createLocalAcpExecutor } from '../../src/runtime/scheduler/local-executor'
import { runSchedulerTick } from '../../src/runtime/scheduler/tick'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

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

/** A2A/派发对账都依赖 goal→task→subtask 链（executions 有外键）。 */
function seedChain(database: Db): string {
  const at = asTimestamp(new Date().toISOString())
  let state = appendEvent(database, emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('g1'),
      userId: 'local',
      title: 'goal',
      intent: 'goal',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  }).state
  state = appendEvent(database, state, {
    type: 'task.created',
    task: {
      id: asTaskId('t1'),
      goalId: asGoalId('g1'),
      title: 'task',
      description: 'task',
      status: 'draft',
      priority: 0,
      acceptanceCriteria: [],
      createdAt: at,
      updatedAt: at,
    },
  }).state
  appendEvent(database, state, {
    type: 'subtask.created',
    subtask: {
      id: asSubtaskId('s1'),
      taskId: asTaskId('t1'),
      title: 'subtask',
      description: 'subtask',
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: [],
      assignedAgentId: asAgentId('a1'),
      priority: 0,
      maxAttempts: 1,
      createdAt: at,
      updatedAt: at,
    },
  })
  return deriveIdempotencyKey({ goalId: 'g1', subtaskId: 's1', attempt: 1 })
}

function enqueue(database: Db, idempotencyKey: string) {
  return enqueueDispatch(database, {
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'local-acp',
    agentId: 'a1',
    objective: '改一个文件',
    idempotencyKey,
    payload: { worktree: '/tmp/hubagent-crash' },
  })
}

/** 记下“是否真的启动了执行”；崩溃点用例里它必须保持 0。 */
function spyExecutor(ran: string[]) {
  return async (intent: { id: string; subtaskId: string }) => {
    ran.push(intent.id)
    return {
      ok: true,
      nextDecision: {
        reason: 'subtask_terminal',
        dedupeKey: `subtask:${intent.subtaskId}:terminal`,
      },
    }
  }
}

const deadProvider = {
  describe: () => ({ kind: 'srt', platform: 'test', ready: true, detail: '' }),
  wrap: () => {
    throw new Error('不该启动执行：对账应在此之前短路')
  },
  dispose: async () => {},
} as unknown as SandboxProvider

describe('崩溃矩阵：每个死亡点都不能丢任务或重复执行', () => {
  it('① 崩在 claim 之前：意图仍是 pending，由 tick 执行一次', async () => {
    const database = db()
    seedChain(database)
    const { intent } = enqueue(database, 'k1')
    const ran: string[] = []

    const report = await runSchedulerTick(database, {
      createExecutor: () => spyExecutor(ran),
      now: new Date(),
    })

    expect(report.handled).toEqual([intent.id])
    expect(ran).toEqual([intent.id])
    expect(listDispatches(database, 'g1')[0]?.status).toBe('done')
  })

  it('② 崩在 claim 之后、执行之前：过期 claim 被回收并执行', async () => {
    const database = db()
    seedChain(database)
    const { intent } = enqueue(database, 'k1')
    claimDispatch(database, { goalId: 'g1', claimedBy: 'dead', now: new Date('2020-01-01') })
    const ran: string[] = []

    const report = await runSchedulerTick(database, { createExecutor: () => spyExecutor(ran) })

    expect(report.reclaimedDispatches).toEqual([intent.id])
    expect(report.handled).toEqual([intent.id])
    expect(ran).toEqual([intent.id])
  })

  it('③ 崩在执行中：已有在途执行 → 退回 pending，绝不启动第二次', async () => {
    const database = db()
    const key = seedChain(database)
    reserveDelegation(database, { subtaskId: 's1', idempotencyKey: key, executionId: 'e1' })
    database
      .prepare(
        `INSERT INTO executions (id, task_id, subtask_id, agent_id, status, attempt, created_at)
         VALUES ('e1', 't1', 's1', 'a1', 'running', 1, ?)`,
      )
      .run(new Date().toISOString())

    const { intent } = enqueue(database, key)
    claimDispatch(database, { goalId: 'g1', claimedBy: 'dead', now: new Date('2020-01-01') })

    const executor = createLocalAcpExecutor({
      db: database,
      provider: deadProvider,
      findAgent: () => undefined,
    })
    const report = await runSchedulerTick(database, { createExecutor: () => executor })

    expect(report.requeued).toEqual([intent.id])
    expect(report.handled).toEqual([])
    /* 执行仍只有一条：没有因为重试而多开一个 ACP 会话。 */
    const count = database.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    expect(count.n).toBe(1)
    expect(listDispatches(database, 'g1')[0]?.status).toBe('pending')
  })

  it('④ 崩在写结果之后、收尾之前：按已有终态对账，不重跑', async () => {
    const database = db()
    const key = seedChain(database)
    reserveDelegation(database, { subtaskId: 's1', idempotencyKey: key, executionId: 'e1' })
    database
      .prepare(
        `INSERT INTO executions (id, task_id, subtask_id, agent_id, status, attempt, created_at)
         VALUES ('e1', 't1', 's1', 'a1', 'succeeded', 1, ?)`,
      )
      .run(new Date().toISOString())

    const { intent } = enqueue(database, key)
    claimDispatch(database, { goalId: 'g1', claimedBy: 'dead', now: new Date('2020-01-01') })

    const executor = createLocalAcpExecutor({
      db: database,
      provider: deadProvider,
      findAgent: () => undefined,
    })
    const report = await runSchedulerTick(database, { createExecutor: () => executor })

    expect(report.handled).toEqual([intent.id])
    expect(listDispatches(database, 'g1')[0]?.status).toBe('done')
    const count = database.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    expect(count.n).toBe(1)
  })
})
