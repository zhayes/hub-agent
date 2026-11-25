import { afterEach, describe, expect, it } from 'vitest'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { addAgent, markAgentSeen } from '../../src/runtime/agent-registry'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { derivePresence, listAgentPresence } from '../../src/storage/queries/agent-presence'
import { loadState } from '../../src/storage/queries/state'
import { appendEvent } from '../../src/storage/write/events'

const AT = asTimestamp('2026-11-25T09:55:48.000Z')
const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function freshDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  return db
}

function seedTask(db: Db): void {
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
      title: 'Refactor session resume',
      description: 'task',
      status: 'draft',
      priority: 0,
      acceptanceCriteria: [],
      createdAt: AT,
      updatedAt: AT,
    },
  }).state
  for (const [id, title] of [
    ['s1', 'Fix lock contention'],
    ['s2', 'Wire evidence capture'],
    ['s3', 'Record verification'],
  ] as const) {
    state = appendEvent(db, state, {
      type: 'subtask.created',
      subtask: {
        id: asSubtaskId(id),
        taskId: asTaskId('t1'),
        title,
        description: title,
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
  }
}

/** 创建一条执行并推进到目标状态；返回 executionId。 */
function seedExecution(
  db: Db,
  agentId: string,
  subtaskId: string,
  status: 'created' | 'starting' | 'running' | 'waiting_permission' | 'waiting_input',
): string {
  const executionId = 'e1'
  appendEvent(db, loadState(db), {
    type: 'execution.created',
    execution: {
      id: asExecutionId(executionId),
      taskId: asTaskId('t1'),
      subtaskId: asSubtaskId(subtaskId),
      agentId: asAgentId(agentId),
      status: 'created',
      attempt: 2,
      createdAt: AT,
    },
  })
  const advance = (to: 'starting' | 'running' | 'waiting_permission' | 'waiting_input'): void => {
    appendEvent(db, loadState(db), {
      type: 'execution.status',
      executionId: asExecutionId(executionId),
      to,
      at: AT,
    })
  }
  if (status === 'created') return executionId
  advance('starting')
  if (status === 'starting') return executionId
  advance('running')
  if (status === 'running') return executionId
  advance(status)
  return executionId
}

describe('derivePresence', () => {
  it('disabled 优先于一切', () => {
    expect(derivePresence({ status: 'disabled', lastSeenAt: 'x', hasActiveExecution: true })).toBe(
      'disabled',
    )
  })

  it('error / degraded / offline 直接映射', () => {
    expect(derivePresence({ status: 'error', lastSeenAt: 'x', hasActiveExecution: false })).toBe(
      'error',
    )
    expect(derivePresence({ status: 'degraded', lastSeenAt: 'x', hasActiveExecution: false })).toBe(
      'degraded',
    )
    expect(derivePresence({ status: 'offline', lastSeenAt: 'x', hasActiveExecution: true })).toBe(
      'offline',
    )
  })

  it('starting / initializing 透传', () => {
    expect(derivePresence({ status: 'starting', lastSeenAt: 'x', hasActiveExecution: false })).toBe(
      'starting',
    )
    expect(
      derivePresence({ status: 'initializing', lastSeenAt: 'x', hasActiveExecution: false }),
    ).toBe('initializing')
  })

  it('从未握手 → discovered（即使有残留执行）', () => {
    expect(derivePresence({ status: 'online', hasActiveExecution: true })).toBe('discovered')
  })

  it('有活跃执行 → busy，否则 online', () => {
    expect(derivePresence({ status: 'online', lastSeenAt: 'x', hasActiveExecution: true })).toBe(
      'busy',
    )
    expect(derivePresence({ status: 'online', lastSeenAt: 'x', hasActiveExecution: false })).toBe(
      'online',
    )
  })
})

describe('listAgentPresence', () => {
  it('空库返回空 agents 与 asOf', () => {
    const snapshot = listAgentPresence(freshDb(), new Date('2026-11-25T10:00:00.000Z'))
    expect(snapshot.agents).toEqual([])
    expect(snapshot.asOf).toBe('2026-11-25T10:00:00.000Z')
  })

  it('未握手的 Agent → discovered，且不带 activity', () => {
    const db = freshDb()
    addAgent(db, { name: 'Claude-Code', command: 'claude' })
    const [agent] = listAgentPresence(db).agents
    expect(agent?.presence).toBe('discovered')
    expect(agent?.activity).toBeUndefined()
    expect(agent?.parallelCount).toBe(0)
  })

  it('握手 + 活跃执行 → busy，activity 带 task/subtask/step/attempt', () => {
    const db = freshDb()
    seedTask(db)
    const record = addAgent(db, { name: 'Claude-Code', command: 'claude' })
    markAgentSeen(db, record.id, { status: 'online', capabilities: ['coding', 'refactor'] })
    seedExecution(db, record.id, 's2', 'running')

    const [agent] = listAgentPresence(db).agents
    expect(agent?.presence).toBe('busy')
    expect(agent?.capabilities).toEqual(['coding', 'refactor'])
    expect(agent?.activity?.taskTitle).toBe('Refactor session resume')
    expect(agent?.activity?.subtaskTitle).toBe('Wire evidence capture')
    expect(agent?.activity?.step).toBe(2)
    expect(agent?.activity?.steps).toBe(3)
    expect(agent?.activity?.attempt).toBe(2)
    expect(agent?.activity?.waitingOn).toBeNull()
    expect(agent?.lastEvent?.type).toBe('execution.status')
  })

  it('waiting_permission → busy + waitingOn=permission', () => {
    const db = freshDb()
    seedTask(db)
    const record = addAgent(db, { name: 'Claude-Code', command: 'claude' })
    markAgentSeen(db, record.id, { status: 'online' })
    seedExecution(db, record.id, 's1', 'waiting_permission')

    const [agent] = listAgentPresence(db).agents
    expect(agent?.presence).toBe('busy')
    expect(agent?.activity?.waitingOn).toBe('permission')
  })

  it('握手但无活跃执行 → online（paused 不算活跃）', () => {
    const db = freshDb()
    seedTask(db)
    const record = addAgent(db, { name: 'Claude-Code', command: 'claude' })
    markAgentSeen(db, record.id, { status: 'online' })

    const [agent] = listAgentPresence(db).agents
    expect(agent?.presence).toBe('online')
    expect(agent?.activity).toBeUndefined()
  })

  it('重复查询同一快照结果稳定', () => {
    const db = freshDb()
    seedTask(db)
    const record = addAgent(db, { name: 'Claude-Code', command: 'claude' })
    markAgentSeen(db, record.id, { status: 'online' })
    seedExecution(db, record.id, 's1', 'running')
    const at = new Date('2026-11-25T10:00:00.000Z')
    expect(listAgentPresence(db, at)).toEqual(listAgentPresence(db, at))
  })
})
