import { type Message, Role, type SendMessageRequest, type Task, TaskState } from '@a2a-js/sdk'
import {
  type AgentExecutionEvent,
  type ExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import { describe, expect, it } from 'vitest'
import { buildAgentCard } from '../../src/adapters/a2a/card'
import {
  isInterruptedTaskState,
  isTerminalTaskState,
  toTaskState,
} from '../../src/adapters/a2a/mapping'
import { createSqliteTaskStore } from '../../src/adapters/a2a/task-store'
import type { TASK_STATUSES } from '../../src/domain/status'
import type { InboundTaskRunner } from '../../src/runtime/a2a-executor'
import { createA2aExecutor } from '../../src/runtime/a2a-executor'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

type LocalTaskStatus = (typeof TASK_STATUSES)[number]

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  return value
}

function callContext(userName = 'peer-a'): ServerCallContext {
  const user = {
    get isAuthenticated(): boolean {
      return true
    },
    get userName(): string {
      return userName
    },
  }
  return new ServerCallContext({ user })
}

function sendRequest(text: string): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: 'm1',
      role: Role.ROLE_USER,
      contextId: '',
      taskId: '',
      parts: [
        {
          content: { $case: 'text', value: text },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
      ],
      extensions: [],
      referenceTaskIds: [],
      metadata: {},
    },
    configuration: undefined,
    metadata: {},
  }
}

function task(id: string, contextId: string, state: TaskState): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: {},
  }
}

describe('A2A 适配：状态映射（PRD §7.6.2）', () => {
  it('本地 Task 状态逐一映射到规范状态，不留空洞', () => {
    const cases: Record<LocalTaskStatus, TaskState> = {
      draft: TaskState.TASK_STATE_SUBMITTED,
      planning: TaskState.TASK_STATE_SUBMITTED,
      ready: TaskState.TASK_STATE_SUBMITTED,
      running: TaskState.TASK_STATE_WORKING,
      paused: TaskState.TASK_STATE_WORKING,
      waiting_input: TaskState.TASK_STATE_INPUT_REQUIRED,
      waiting_approval: TaskState.TASK_STATE_AUTH_REQUIRED,
      completed: TaskState.TASK_STATE_COMPLETED,
      failed: TaskState.TASK_STATE_FAILED,
      canceled: TaskState.TASK_STATE_CANCELED,
    }
    for (const [local, expected] of Object.entries(cases)) {
      expect(toTaskState(local as LocalTaskStatus)).toBe(expected)
    }
  })

  it('终态与中断态区分正确（流关闭 vs 可续）', () => {
    expect(isTerminalTaskState(TaskState.TASK_STATE_COMPLETED)).toBe(true)
    expect(isTerminalTaskState(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe(false)
    expect(isInterruptedTaskState(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe(true)
    expect(isInterruptedTaskState(TaskState.TASK_STATE_COMPLETED)).toBe(false)
  })
})

describe('A2A 适配：Agent Card', () => {
  it('只声明 1.0 + JSONRPC，不声明 0.3（空版本头会被当成 0.3）', () => {
    const card = buildAgentCard({
      name: 'hub',
      description: 'd',
      version: '1.0.0',
      url: 'https://127.0.0.1:8443/a2a',
      streaming: true,
    })
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC')
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe('1.0')
    expect(card.capabilities?.pushNotifications).toBe(false)
  })
})

describe('A2A 适配：SQLite TaskStore', () => {
  it('按 owner 隔离：别的 peer 读不到', async () => {
    const store = createSqliteTaskStore(db())
    await store.save(task('t1', 'c1', TaskState.TASK_STATE_WORKING), callContext('peer-a'))

    expect(await store.load('t1', callContext('peer-a'))).toBeDefined()
    expect(await store.load('t1', callContext('peer-b'))).toBeUndefined()
  })

  it('同 ID 覆盖而不是新增', async () => {
    const store = createSqliteTaskStore(db())
    const ctx = callContext('peer-a')
    await store.save(task('t1', 'c1', TaskState.TASK_STATE_WORKING), ctx)
    await store.save(task('t1', 'c1', TaskState.TASK_STATE_COMPLETED), ctx)

    const loaded = await store.load('t1', ctx)
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('list 按 owner 与状态过滤，并给出分页信息', async () => {
    const store = createSqliteTaskStore(db())
    const ctx = callContext('peer-a')
    await store.save(task('t1', 'c1', TaskState.TASK_STATE_WORKING), ctx)
    await store.save(task('t2', 'c1', TaskState.TASK_STATE_COMPLETED), ctx)
    await store.save(task('t3', 'c1', TaskState.TASK_STATE_WORKING), callContext('peer-b'))

    const all = await store.list(
      {
        tenant: '',
        contextId: '',
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
      },
      ctx,
    )
    expect(all.totalSize).toBe(2)
    expect(all.tasks.map((item) => item.id).sort()).toEqual(['t1', 't2'])
    expect(all.nextPageToken).toBe('')

    const working = await store.list(
      {
        tenant: '',
        contextId: '',
        status: TaskState.TASK_STATE_WORKING,
        pageToken: '',
        statusTimestampAfter: undefined,
      },
      ctx,
    )
    expect(working.tasks.map((item) => item.id)).toEqual(['t1'])
  })
})

describe('A2A 执行器：事件顺序与终态', () => {
  function fakeBus(): { bus: ExecutionEventBus; events: AgentExecutionEvent[] } {
    const events: AgentExecutionEvent[] = []
    const bus = {
      publish: (event: AgentExecutionEvent) => events.push(event),
      on: () => undefined,
      off: () => undefined,
      finished: () => undefined,
      removeAllListeners: () => undefined,
    } as unknown as ExecutionEventBus
    return { bus, events }
  }

  function context(taskId = 't1'): RequestContext {
    return new RequestContext(sendRequest('把 README 改短一点'), taskId, 'c1', callContext())
  }

  function runner(outcome: Awaited<ReturnType<InboundTaskRunner['run']>>): InboundTaskRunner {
    return {
      run: async () => outcome,
      cancel: async () => ({ contextId: 'c1' }),
    }
  }

  it('首帧是 task，随后 statusUpdate，最后是终态', async () => {
    const { bus, events } = fakeBus()
    await createA2aExecutor(runner({ state: 'completed', summary: 'done' })).execute(context(), bus)

    expect(events[0]?.kind).toBe('task')
    expect(events.map((event) => event.kind)).toEqual(['task', 'statusUpdate', 'statusUpdate'])
    const last = events.at(-1)
    expect(last?.kind === 'statusUpdate' && last.data.status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    )
  })

  it('需要更多输入时报 INPUT_REQUIRED（可续），不是终态', async () => {
    const { bus, events } = fakeBus()
    await createA2aExecutor(runner({ state: 'input_required', question: '哪个 README？' })).execute(
      context(),
      bus,
    )

    const last = events.at(-1)
    const state = last?.kind === 'statusUpdate' ? last.data.status?.state : undefined
    expect(state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(state !== undefined && isTerminalTaskState(state)).toBe(false)
  })

  it('runner 抛错不炸流，按 FAILED 收尾', async () => {
    const { bus, events } = fakeBus()
    const failing: InboundTaskRunner = {
      run: async () => {
        throw new Error('沙箱拒绝启动')
      },
      cancel: async () => ({ contextId: 'c1' }),
    }
    await createA2aExecutor(failing).execute(context(), bus)

    const last = events.at(-1)
    expect(last?.kind === 'statusUpdate' && last.data.status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    )
  })

  it('取消发 CANCELED 终态，并复用 runner 回报的 contextId', async () => {
    const { bus, events } = fakeBus()
    await createA2aExecutor(runner({ state: 'completed' })).cancelTask('t1', bus)

    const [event] = events
    expect(event?.kind).toBe('statusUpdate')
    if (event?.kind === 'statusUpdate') {
      expect(event.data.status?.state).toBe(TaskState.TASK_STATE_CANCELED)
      expect(event.data.contextId).toBe('c1')
    }
  })
})

/** 只是为了让 Message 类型在本文件被真正使用一次，避免 lint 抱怨未使用导入。 */
export type _Message = Message
