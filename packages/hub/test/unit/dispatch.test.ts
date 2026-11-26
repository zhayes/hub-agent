import { afterEach, describe, expect, it } from 'vitest'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { listDecisionPoints } from '../../src/runtime/decision-queue'
import {
  createAcpDispatchExecutor,
  lookupExistingExecution,
} from '../../src/runtime/dispatch/acp-executor'
import {
  claimDispatch,
  completeDispatch,
  DISPATCH_MAX_ATTEMPTS,
  enqueueDispatch,
  listDispatches,
  reclaimExpiredDispatches,
} from '../../src/runtime/dispatch/queue'
import { drainDispatches } from '../../src/runtime/dispatch/runner'
import type { DispatchIntent } from '../../src/runtime/dispatch/types'
import { deriveExecutionId, reserveDelegation } from '../../src/runtime/recovery/idempotency'
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

const T0 = new Date('2026-01-01T00:00:00.000Z')

function at(n: number): Date {
  return new Date(T0.getTime() + n * 60_000)
}

function enqueue(database: Db, overrides: Partial<Parameters<typeof enqueueDispatch>[1]> = {}) {
  return enqueueDispatch(database, {
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'local-acp',
    objective: '改一个文件',
    idempotencyKey: 'g1:s1:1',
    ...overrides,
  })
}

function statusOf(database: Db, id: string): string {
  const row = database.prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(id) as {
    status: string
  }
  return row.status
}

describe('派发意图队列', () => {
  it('同一 idempotencyKey 只入队一次', () => {
    const database = db()
    expect(enqueue(database).created).toBe(true)
    expect(enqueue(database).created).toBe(false)
    expect(listDispatches(database, 'g1')).toHaveLength(1)
  })

  it('claim 生成 token 并累加 attempts；已领的不会再被领', () => {
    const database = db()
    const { intent } = enqueue(database)

    const claimed = claimDispatch(database, { goalId: 'g1', claimedBy: 'runner', now: T0 })
    expect(claimed?.id).toBe(intent.id)
    expect(claimed?.claimToken).toBeTypeOf('string')
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.claimedAt).toBe(T0.toISOString())

    expect(claimDispatch(database, { goalId: 'g1', claimedBy: 'runner' })).toBeUndefined()
  })

  it('收尾必须匹配 claimToken；旧 token 不能改写', () => {
    const database = db()
    const { intent } = enqueue(database)
    const claimed = claimDispatch(database, { goalId: 'g1', claimedBy: 'runner', now: T0 })

    expect(completeDispatch(database, intent.id, { claimToken: 'wrong', status: 'done' })).toBe(
      false,
    )
    expect(statusOf(database, intent.id)).toBe('claimed')

    expect(
      completeDispatch(database, intent.id, {
        claimToken: claimed?.claimToken ?? '',
        status: 'done',
      }),
    ).toBe(true)
    expect(statusOf(database, intent.id)).toBe('done')
  })

  it('runner 执行意图，并在同一事务里写入下一决策点', async () => {
    const database = db()
    const { intent } = enqueue(database)
    const seen: DispatchIntent[] = []

    const report = await drainDispatches(database, {
      executor: async (item) => {
        seen.push(item)
        return {
          ok: true,
          nextDecision: { reason: 'subtask_terminal', dedupeKey: `subtask:${item.subtaskId}` },
        }
      },
    })

    expect(report.handled).toEqual([intent.id])
    expect(report.truncated).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.target).toBe('local-acp')

    expect(statusOf(database, intent.id)).toBe('done')
    const decisions = listDecisionPoints(database, 'g1')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.dedupeKey).toBe('subtask:s1')
    expect(decisions[0]?.reason).toBe('subtask_terminal')
  })

  it('executor 抛错记 failed，且不写决策点', async () => {
    const database = db()
    const { intent } = enqueue(database)

    const report = await drainDispatches(database, {
      executor: async () => {
        throw new Error('沙箱拒绝启动')
      },
    })

    expect(report.failed).toEqual([intent.id])
    expect(statusOf(database, intent.id)).toBe('failed')
    expect(listDecisionPoints(database, 'g1')).toHaveLength(0)
  })

  it('收尾与决策点同事务：写决策点失败则意图状态回滚', async () => {
    const database = db()
    const { intent } = enqueue(database)
    database.exec(`
      CREATE TRIGGER fail_decision_insert BEFORE INSERT ON decision_queue
      BEGIN SELECT RAISE(ABORT, 'injected crash'); END;
    `)

    await expect(
      drainDispatches(database, {
        executor: async (item) => ({
          ok: true,
          nextDecision: { reason: 'subtask_terminal', dedupeKey: `subtask:${item.subtaskId}` },
        }),
      }),
    ).rejects.toThrow()

    /* 不能出现「意图已 done、决策点却没写」的半状态。 */
    expect(statusOf(database, intent.id)).toBe('claimed')
    expect(listDecisionPoints(database, 'g1')).toHaveLength(0)
  })

  it('过期 claim 可回收，且按 Goal 收窄', () => {
    const database = db()
    enqueue(database, { goalId: 'g1', idempotencyKey: 'g1:s1:1' })
    enqueue(database, { goalId: 'g2', taskId: 't2', subtaskId: 's2', idempotencyKey: 'g2:s2:1' })
    claimDispatch(database, { goalId: 'g1', claimedBy: 'runner', now: T0 })
    claimDispatch(database, { goalId: 'g2', claimedBy: 'runner', now: T0 })

    expect(reclaimExpiredDispatches(database, { goalId: 'g1', now: at(40) })).toHaveLength(1)
    expect(listDispatches(database, 'g1')[0]?.status).toBe('pending')
    expect(listDispatches(database, 'g2')[0]?.status).toBe('claimed')
  })

  it('attempts 到上限后判 failed，不再无限重领', () => {
    const database = db()
    const { intent } = enqueue(database)

    for (let round = 0; round < DISPATCH_MAX_ATTEMPTS; round += 1) {
      const claimed = claimDispatch(database, { goalId: 'g1', claimedBy: 'runner', now: at(round) })
      expect(claimed?.id).toBe(intent.id)
      /* 每次都让租约过期被回收，模拟执行侧反复挂掉。 */
      reclaimExpiredDispatches(database, { now: at(round + 40) })
    }

    expect(
      claimDispatch(database, { goalId: 'g1', claimedBy: 'runner', now: at(400) }),
    ).toBeUndefined()
    expect(statusOf(database, intent.id)).toBe('failed')
  })

  it('执行器要求退回时，意图回 pending 且本轮结束', async () => {
    const database = db()
    const { intent } = enqueue(database)

    const report = await drainDispatches(database, {
      executor: async () => ({ ok: false, requeue: true, error: 'in-flight' }),
    })

    expect(report.requeued).toEqual([intent.id])
    expect(statusOf(database, intent.id)).toBe('pending')
    expect(listDecisionPoints(database, 'g1')).toHaveLength(0)
  })
})

describe('ACP 派发执行器（D4 对账）', () => {
  const intent = (overrides: Partial<DispatchIntent> = {}): DispatchIntent => ({
    id: 'd1',
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'local-acp',
    objective: '改一个文件',
    idempotencyKey: 'g1:s1:1',
    status: 'claimed',
    attempts: 1,
    createdAt: T0.toISOString(),
    ...overrides,
  })

  it('首次派发用派生 executionId 执行，并给出下一决策点', async () => {
    const database = db()
    const seen: string[] = []
    const executor = createAcpDispatchExecutor({
      db: database,
      runTask: async (_item, executionId) => {
        seen.push(executionId)
        return { ok: true }
      },
      lookupExisting: () => undefined,
      decisionFor: (item) => ({
        reason: 'subtask_terminal',
        dedupeKey: `goal:${item.goalId}:dispatch:1`,
      }),
    })

    const outcome = await executor(intent())

    expect(seen).toEqual([deriveExecutionId('g1:s1:1')])
    expect(outcome.ok).toBe(true)
    expect(outcome.nextDecision?.dedupeKey).toBe('goal:g1:dispatch:1')
  })

  it('重放且执行已成功：不重跑，直接收尾', async () => {
    const database = db()
    let ran = 0
    const executor = createAcpDispatchExecutor({
      db: database,
      runTask: async () => {
        ran += 1
        return { ok: true }
      },
      lookupExisting: () => ({ executionId: 'e1', status: 'succeeded' }),
    })

    const outcome = await executor(intent())
    expect(ran).toBe(0)
    expect(outcome.ok).toBe(true)
    expect(outcome.nextDecision).toBeDefined()
  })

  it('重放且执行已失败：不重跑，报失败', async () => {
    const database = db()
    let ran = 0
    const executor = createAcpDispatchExecutor({
      db: database,
      runTask: async () => {
        ran += 1
        return { ok: true }
      },
      lookupExisting: () => ({ executionId: 'e1', status: 'failed' }),
    })

    const outcome = await executor(intent())
    expect(ran).toBe(0)
    expect(outcome.ok).toBe(false)
    expect(outcome.requeue).toBeUndefined()
  })

  it('已有在途执行：要求退回，绝不重复启动', async () => {
    const database = db()
    let ran = 0
    const executor = createAcpDispatchExecutor({
      db: database,
      runTask: async () => {
        ran += 1
        return { ok: true }
      },
      lookupExisting: () => ({ executionId: 'e1', status: 'running' }),
    })

    const outcome = await executor(intent())
    expect(ran).toBe(0)
    expect(outcome.requeue).toBe(true)
  })

  it('默认查重：契约在但执行行缺失时返回 status undefined', () => {
    const database = db()
    seedSubtask(database)
    reserveDelegation(database, {
      subtaskId: 's1',
      idempotencyKey: 'g1:s1:1',
      executionId: 'e-missing',
    })

    expect(lookupExistingExecution(database, 'g1:s1:1')).toEqual({ executionId: 'e-missing' })
    expect(lookupExistingExecution(database, 'nope')).toBeUndefined()
  })
})

/** 只有订阅了具体 subtask 的测试需要：delegation_contracts 对 subtasks 有外键。 */
function seedSubtask(database: Db): void {
  const at = asTimestamp(T0.toISOString())
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
}
