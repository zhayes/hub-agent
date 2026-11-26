import { TaskState } from '@a2a-js/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteAgentClient } from '../../src/adapters/a2a/client'
import { fromTaskState } from '../../src/adapters/a2a/mapping'
import { isTerminalRemoteState } from '../../src/domain/status'
import { enqueueDispatch } from '../../src/runtime/dispatch/queue'
import { drainDispatches } from '../../src/runtime/dispatch/runner'
import { createRemoteDispatchExecutor, deriveMessageId } from '../../src/runtime/remote-dispatch'
import {
  attachLocalExecution,
  findRemoteTaskByIdempotencyKey,
  listRemoteTasks,
  listRemoteTasksNeedingPoll,
  observeRemoteTask,
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

function remember(database: Db, overrides: Partial<Parameters<typeof rememberRemoteTask>[1]> = {}) {
  return rememberRemoteTask(database, {
    goalId: 'g1',
    peerId: 'peer-b',
    idempotencyKey: 'key-1',
    remoteTaskId: 'rt-1',
    contextId: 'ctx-1',
    messageId: 'msg-1',
    observedState: 'submitted',
    ...overrides,
  })
}

describe('remote_task_refs 仓储', () => {
  it('记录一次派发；同一幂等键重放命中同一行、created=false', () => {
    const database = db()
    const first = remember(database)
    expect(first.created).toBe(true)
    expect(first.ref.observedState).toBe('submitted')
    expect(first.ref.localExecutionId).toBeUndefined()

    const replay = remember(database)
    expect(replay.created).toBe(false)
    expect(replay.ref.id).toBe(first.ref.id)
    expect(listRemoteTasks(database, 'g1')).toHaveLength(1)
  })

  it('同一远端任务被另一个幂等键认领时抛错，不静默合并', () => {
    const database = db()
    remember(database, { idempotencyKey: 'key-1', remoteTaskId: 'rt-1' })
    expect(() => remember(database, { idempotencyKey: 'key-2', remoteTaskId: 'rt-1' })).toThrow(
      /另一个幂等键/,
    )
    expect(findRemoteTaskByIdempotencyKey(database, 'key-2')).toBeUndefined()
  })

  it('观测只写远端状态；游标缺省不清空，last_seen_at 每次刷新', () => {
    const database = db()
    const { ref } = remember(database, { now: at(0) })

    let ok = observeRemoteTask(database, {
      id: ref.id,
      observedState: 'working',
      eventCursor: 'c1',
      now: at(5),
    })
    expect(ok).toBe(true)
    let seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.observedState).toBe('working')
    expect(seen?.eventCursor).toBe('c1')
    expect(seen?.lastSeenAt).toBe(at(5).toISOString())

    /* 不带游标的观测只推进状态与时间，不抹掉已知游标。 */
    ok = observeRemoteTask(database, { id: ref.id, observedState: 'working', now: at(10) })
    expect(ok).toBe(true)
    seen = findRemoteTaskByIdempotencyKey(database, 'key-1')
    expect(seen?.eventCursor).toBe('c1')
    expect(seen?.lastSeenAt).toBe(at(10).toISOString())
  })

  it('回填本地 Execution 只成功一次（UNIQUE 拦住重复绑定）', () => {
    const database = db()
    const { ref } = remember(database)
    expect(attachLocalExecution(database, { id: ref.id, localExecutionId: 'exec-1' })).toBe(true)
    expect(attachLocalExecution(database, { id: ref.id, localExecutionId: 'exec-2' })).toBe(false)
    expect(findRemoteTaskByIdempotencyKey(database, 'key-1')?.localExecutionId).toBe('exec-1')
  })

  it('待对账列表排除终态，最久未刷新优先，可按陈旧度过滤', () => {
    const database = db()
    remember(database, {
      idempotencyKey: 'k-running',
      remoteTaskId: 'rt-a',
      observedState: 'working',
      now: at(0),
    })
    remember(database, {
      idempotencyKey: 'k-done',
      remoteTaskId: 'rt-b',
      observedState: 'completed',
      now: at(1),
    })
    remember(database, {
      idempotencyKey: 'k-input',
      remoteTaskId: 'rt-c',
      observedState: 'input_required',
      now: at(2),
    })

    const all = listRemoteTasksNeedingPoll(database)
    expect(all.map((ref) => ref.remoteTaskId)).toEqual(['rt-a', 'rt-c'])

    const stale = listRemoteTasksNeedingPoll(database, {
      now: at(10),
      staleAfterMs: 5 * 60_000,
    })
    expect(stale.map((ref) => ref.remoteTaskId)).toEqual(['rt-a', 'rt-c'])

    const fresh = listRemoteTasksNeedingPoll(database, {
      now: at(10),
      staleAfterMs: 20 * 60_000,
    })
    expect(fresh).toEqual([])
  })
})

describe('A2A 状态观测映射', () => {
  it('把 SDK TaskState 映射成 PRD 的小写观测值，未知归 unknown', () => {
    expect(fromTaskState(TaskState.TASK_STATE_SUBMITTED)).toBe('submitted')
    expect(fromTaskState(TaskState.TASK_STATE_WORKING)).toBe('working')
    expect(fromTaskState(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('input_required')
    expect(fromTaskState(TaskState.TASK_STATE_AUTH_REQUIRED)).toBe('auth_required')
    expect(fromTaskState(TaskState.TASK_STATE_COMPLETED)).toBe('completed')
    expect(fromTaskState(TaskState.TASK_STATE_FAILED)).toBe('failed')
    expect(fromTaskState(TaskState.TASK_STATE_CANCELED)).toBe('canceled')
    expect(fromTaskState(TaskState.TASK_STATE_REJECTED)).toBe('rejected')
    expect(fromTaskState(TaskState.TASK_STATE_UNSPECIFIED)).toBe('unknown')
  })

  it('只有 completed/failed/canceled/rejected 是终态', () => {
    expect(isTerminalRemoteState('completed')).toBe(true)
    expect(isTerminalRemoteState('rejected')).toBe(true)
    expect(isTerminalRemoteState('input_required')).toBe(false)
    expect(isTerminalRemoteState('unknown')).toBe(false)
  })
})

interface SendRecord {
  text: string
  messageId?: string
}

function recordingConnect(state: TaskState = TaskState.TASK_STATE_SUBMITTED) {
  const sends: SendRecord[] = []
  const connect = async (): Promise<RemoteAgentClient> => ({
    card: async () => {
      throw new Error('card 不该被调用')
    },
    send: async (input) => {
      sends.push(input)
      return { taskId: `rt-${sends.length}`, contextId: 'ctx-remote', state }
    },
    get: async () => {
      throw new Error('get 不该在派发阶段被调用')
    },
    cancel: async () => {
      throw new Error('cancel 不该在派发阶段被调用')
    },
  })
  return { sends, connect }
}

function remoteIntent(overrides: { payload?: unknown; idempotencyKey?: string } = {}) {
  return {
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'remote-a2a' as const,
    objective: '把 README 补上用法',
    idempotencyKey: overrides.idempotencyKey ?? 'key-remote',
    payload: overrides.payload ?? { peerId: 'peer-b' },
  }
}

describe('远程派发执行器（只提交）', () => {
  it('发送一次、落关联、收尾成功且不产出下一决策点', async () => {
    const database = db()
    const { sends, connect } = recordingConnect()
    const executor = createRemoteDispatchExecutor({
      db: database,
      resolvePeer: () => ({ url: 'https://b.example', token: 'tok' }),
      connect,
    })
    const enqueued = enqueueDispatch(database, remoteIntent())

    const report = await drainDispatches(database, { executor, intentId: enqueued.intent.id })
    expect(report.handled).toEqual([enqueued.intent.id])
    expect(sends).toHaveLength(1)
    expect(sends[0]?.text).toBe('把 README 补上用法')
    expect(sends[0]?.messageId).toBe(deriveMessageId('key-remote'))

    const ref = findRemoteTaskByIdempotencyKey(database, 'key-remote')
    expect(ref?.remoteTaskId).toBe('rt-1')
    expect(ref?.contextId).toBe('ctx-remote')
    expect(ref?.observedState).toBe('submitted')
    expect(ref?.messageId).toBe(deriveMessageId('key-remote'))
  })

  it('重放不重发：已有同幂等键关联时直接当成功', async () => {
    const database = db()
    const { sends, connect } = recordingConnect()
    remember(database, { idempotencyKey: 'key-remote' })

    const executor = createRemoteDispatchExecutor({
      db: database,
      resolvePeer: () => ({ url: 'https://b.example', token: 'tok' }),
      connect,
    })
    const enqueued = enqueueDispatch(database, remoteIntent())

    const report = await drainDispatches(database, { executor, intentId: enqueued.intent.id })
    expect(report.handled).toEqual([enqueued.intent.id])
    expect(sends).toHaveLength(0)
  })

  it('未配置 peer 时失败关闭，且不发请求、不落关联', async () => {
    const database = db()
    const { sends, connect } = recordingConnect()
    const executor = createRemoteDispatchExecutor({
      db: database,
      resolvePeer: () => undefined,
      connect,
    })
    const enqueued = enqueueDispatch(database, remoteIntent())

    const report = await drainDispatches(database, { executor, intentId: enqueued.intent.id })
    expect(report.failed).toEqual([enqueued.intent.id])
    expect(sends).toHaveLength(0)
    expect(findRemoteTaskByIdempotencyKey(database, 'key-remote')).toBeUndefined()
  })

  it('发送抛错时标记失败、不落关联（未知不重试）', async () => {
    const database = db()
    const connect = async (): Promise<RemoteAgentClient> => ({
      card: async () => {
        throw new Error('unused')
      },
      send: async () => {
        throw new Error('连接被拒')
      },
      get: async () => {
        throw new Error('unused')
      },
      cancel: async () => {
        throw new Error('unused')
      },
    })
    const executor = createRemoteDispatchExecutor({
      db: database,
      resolvePeer: () => ({ url: 'https://b.example', token: 'tok' }),
      connect,
    })
    const enqueued = enqueueDispatch(database, remoteIntent())

    const report = await drainDispatches(database, { executor, intentId: enqueued.intent.id })
    expect(report.failed).toEqual([enqueued.intent.id])
    expect(findRemoteTaskByIdempotencyKey(database, 'key-remote')).toBeUndefined()
  })

  it('载荷缺 peerId 时按 CONFIG_INVALID 失败，不会被当成成功', async () => {
    const database = db()
    const { sends, connect } = recordingConnect()
    const executor = createRemoteDispatchExecutor({
      db: database,
      resolvePeer: () => ({ url: 'https://b.example', token: 'tok' }),
      connect,
    })
    const enqueued = enqueueDispatch(database, remoteIntent({ payload: {} }))

    const report = await drainDispatches(database, { executor, intentId: enqueued.intent.id })
    expect(report.failed).toEqual([enqueued.intent.id])
    expect(sends).toHaveLength(0)
  })
})
