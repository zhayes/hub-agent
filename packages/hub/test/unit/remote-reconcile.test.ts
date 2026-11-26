import { TaskState } from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/errors'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteAgentClient } from '../../src/adapters/a2a/client'
import { listDecisionPoints } from '../../src/runtime/decision-queue'
import { reconcileRemoteTasks } from '../../src/runtime/remote-reconcile'
import {
  findRemoteTaskByIdempotencyKey,
  listRemoteTasksNeedingPoll,
  rememberRemoteTask,
} from '../../src/runtime/remote-task'
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

const T0 = new Date('2026-01-01T00:00:00.000Z')
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

function task(state: TaskState, timestamp = 'ts-1') {
  return {
    id: 'rt-1',
    contextId: 'ctx-1',
    status: { state, message: undefined, timestamp },
    artifacts: [],
    history: [],
    metadata: {},
  }
}

function connectReturning(get: () => Promise<unknown>): () => Promise<RemoteAgentClient> {
  return async () => ({
    card: async () => {
      throw new Error('card 不该被调用')
    },
    send: async () => {
      throw new Error('对账阶段不得重发')
    },
    get: get as RemoteAgentClient['get'],
    cancel: async () => {
      throw new Error('对账阶段不得取消')
    },
  })
}

function seedRef(database: Db, overrides: { idempotencyKey?: string; now?: Date } = {}) {
  return rememberRemoteTask(database, {
    goalId: 'g1',
    peerId: 'peer-b',
    idempotencyKey: overrides.idempotencyKey ?? 'key-1',
    remoteTaskId: 'rt-1',
    contextId: 'ctx-1',
    messageId: 'msg-1',
    observedState: 'submitted',
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  }).ref
}

const endpoint = { url: 'https://b.example', token: 'tok' }

describe('远端任务对账', () => {
  it('运行中：只刷新观测值与游标，不产出决策点', async () => {
    const database = db()
    const ref = seedRef(database, { now: at(0) })

    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: connectReturning(async () => task(TaskState.TASK_STATE_WORKING, 'ts-2')),
      now: at(1),
    })

    expect(report.polled).toEqual([ref.id])
    expect(report.terminal).toEqual([])
    const seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.observedState).toBe('working')
    expect(seen?.eventCursor).toBe('ts-2')
    expect(seen?.closedAt).toBeUndefined()
    expect(listDecisionPoints(database, 'g1')).toHaveLength(0)
  })

  it('终态：写观测、关单、恰好产出一次决策点；之后不再轮询', async () => {
    const database = db()
    const ref = seedRef(database, { now: at(0) })

    const first = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: connectReturning(async () => task(TaskState.TASK_STATE_COMPLETED)),
      now: at(1),
    })
    expect(first.terminal).toEqual([ref.id])

    const decisions = listDecisionPoints(database, 'g1')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.dedupeKey).toBe(`remote:${ref.id}:terminal`)
    expect(decisions[0]?.reason).toBe('remote_task_terminal')

    const seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.observedState).toBe('completed')
    expect(seen?.closedAt).toBeDefined()
    expect(listRemoteTasksNeedingPoll(database, { now: at(5) })).toEqual([])

    /* 第二轮：已关单，不再对账、不再重复决策。 */
    const second = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: connectReturning(async () => task(TaskState.TASK_STATE_COMPLETED)),
      now: at(5),
    })
    expect(second.terminal).toEqual([])
    expect(second.polled).toEqual([])
    expect(listDecisionPoints(database, 'g1')).toHaveLength(1)
  })

  it('远端已无该任务：关单为 unknown 并产出 lost 决策点，不重发', async () => {
    const database = db()
    const ref = seedRef(database, { now: at(0) })

    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: connectReturning(async () => {
        throw new TaskNotFoundError('no such task')
      }),
      now: at(1),
    })

    expect(report.closed).toEqual([ref.id])
    const seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.observedState).toBe('unknown')
    expect(seen?.closedAt).toBeDefined()
    const decisions = listDecisionPoints(database, 'g1')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.dedupeKey).toBe(`remote:${ref.id}:lost`)
  })

  it('传输错误只在报告里记失败，不改状态也不关单', async () => {
    const database = db()
    const ref = seedRef(database, { now: at(0) })

    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: connectReturning(async () => {
        throw new Error('socket hang up')
      }),
      now: at(1),
    })

    expect(report.failed).toEqual([{ id: ref.id, error: 'socket hang up' }])
    const seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.observedState).toBe('submitted')
    expect(seen?.closedAt).toBeUndefined()
    expect(listDecisionPoints(database, 'g1')).toHaveLength(0)
  })

  it('未配置 peer 时记失败且不发请求', async () => {
    const database = db()
    seedRef(database, { now: at(0) })

    let connected = false
    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => undefined,
      connect: async () => {
        connected = true
        throw new Error('不该连接')
      },
      now: at(1),
    })

    expect(connected).toBe(false)
    expect(report.failed[0]?.error).toContain('未配置的 peer')
  })

  it('刚刷新过的关联在 staleAfterMs 内不被对账', async () => {
    const database = db()
    seedRef(database, { now: at(0) })

    let called = 0
    const report = await reconcileRemoteTasks({
      db: database,
      resolvePeer: () => endpoint,
      connect: async () => {
        called += 1
        return {
          card: async () => {
            throw new Error('unused')
          },
          send: async () => {
            throw new Error('unused')
          },
          get: async () => task(TaskState.TASK_STATE_WORKING),
          cancel: async () => {
            throw new Error('unused')
          },
        }
      },
      now: at(0),
      staleAfterMs: 15_000,
    })

    expect(called).toBe(0)
    expect(report).toEqual({ polled: [], terminal: [], closed: [], failed: [] })
  })
})
