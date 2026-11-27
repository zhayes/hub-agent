import { afterEach, describe, expect, it } from 'vitest'
import type { Goal, Subtask, Task } from '../../src/domain/entities'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { acceptExecution, rejectExecution } from '../../src/runtime/acceptance'
import { listDecisionPoints } from '../../src/runtime/decision-queue'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { loadState } from '../../src/storage/queries/state'
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

const GOAL = asGoalId('g1')
const TASK = asTaskId('t1')
const SUBTASK = asSubtaskId('s1')
const EXEC = asExecutionId('e1')
const at = asTimestamp('2026-01-01T00:00:00.000Z')

/** 造一个“执行停在 waiting_input”的最小图（人工验收的入口状态）。 */
function seedWaitingExecution(database: Db): void {
  const goal: Goal = {
    id: GOAL,
    userId: 'local',
    title: '目标',
    intent: '意图',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const task: Task = {
    id: TASK,
    goalId: GOAL,
    title: '任务',
    description: '描述',
    status: 'draft',
    priority: 0,
    acceptanceCriteria: ['可验收'],
    createdAt: at,
    updatedAt: at,
  }
  const subtask: Subtask = {
    id: SUBTASK,
    taskId: TASK,
    title: '子任务',
    description: '做事',
    status: 'ready',
    required: true,
    dependencies: [],
    requiredCapabilities: [],
    priority: 0,
    maxAttempts: 1,
    createdAt: at,
    updatedAt: at,
  }

  let state = loadState(database)
  for (const event of [
    { type: 'goal.created' as const, goal },
    { type: 'task.created' as const, task },
    { type: 'task.status' as const, taskId: TASK, to: 'planning' as const, at },
    { type: 'task.status' as const, taskId: TASK, to: 'ready' as const, at },
    { type: 'task.status' as const, taskId: TASK, to: 'running' as const, at },
    { type: 'subtask.created' as const, subtask },
    { type: 'subtask.status' as const, subtaskId: SUBTASK, to: 'assigned' as const, at },
    { type: 'subtask.status' as const, subtaskId: SUBTASK, to: 'running' as const, at },
    {
      type: 'execution.created' as const,
      execution: {
        id: EXEC,
        taskId: TASK,
        subtaskId: SUBTASK,
        agentId: asAgentId('remote:peer-b'),
        status: 'created' as const,
        attempt: 1,
        createdAt: at,
      },
    },
    { type: 'execution.status' as const, executionId: EXEC, to: 'starting' as const, at },
    { type: 'execution.status' as const, executionId: EXEC, to: 'running' as const, at },
    { type: 'execution.status' as const, executionId: EXEC, to: 'waiting_input' as const, at },
    { type: 'subtask.status' as const, subtaskId: SUBTASK, to: 'waiting_input' as const, at },
    { type: 'task.status' as const, taskId: TASK, to: 'waiting_input' as const, at },
  ]) {
    state = appendEvent(database, state, event).state
  }
}

function statuses(database: Db) {
  const state = loadState(database)
  return {
    execution: state.executions[EXEC]?.status,
    subtask: state.subtasks[SUBTASK]?.status,
    task: state.tasks[TASK]?.status,
  }
}

describe('人工验收：waiting_input → 收敛', () => {
  it('接受 → 记一条 human 验收、执行/子任务成功、Task 回到 running、产生决策点', () => {
    const database = db()
    seedWaitingExecution(database)

    const result = acceptExecution(database, { executionId: 'e1', note: '看过 diff 了' })
    expect(result.verdict).toBe('pass')

    expect(statuses(database)).toEqual({
      execution: 'succeeded',
      subtask: 'succeeded',
      task: 'running',
    })

    const state = loadState(database)
    const run = Object.values(state.verifications).find((item) => item.executionId === EXEC)
    expect(run?.decidedBy).toBe('human')
    expect(run?.verdict).toBe('pass')
    expect(run?.checks[0]?.kind).toBe('llmReview')
    expect(run?.checks[0]?.passed).toBe(true)

    const points = listDecisionPoints(database, 'g1')
    expect(points.map((point) => point.reason)).toEqual(['human_accepted'])
  })

  it('拒绝 → 执行/子任务/Task 都失败，并产生重规划用的决策点', () => {
    const database = db()
    seedWaitingExecution(database)

    const result = rejectExecution(database, { executionId: 'e1', reason: '产物不对' })
    expect(result.verdict).toBe('fail')

    const state = loadState(database)
    const run = Object.values(state.verifications).find((item) => item.executionId === EXEC)
    expect(run?.decidedBy).toBe('human')
    expect(run?.verdict).toBe('fail')
    expect(run?.checks[0]?.passed).toBe(false)

    expect(statuses(database)).toEqual({
      execution: 'failed',
      subtask: 'failed',
      task: 'failed',
    })
    expect(listDecisionPoints(database, 'g1').map((point) => point.reason)).toEqual([
      'human_rejected',
    ])
  })

  it('重复接受被拒：第二次已不在 waiting_input', () => {
    const database = db()
    seedWaitingExecution(database)
    acceptExecution(database, { executionId: 'e1' })
    expect(() => acceptExecution(database, { executionId: 'e1' })).toThrow(/不在等待人工验收状态/)
  })

  it('对不存在或非等待态的执行拒绝接受', () => {
    const database = db()
    seedWaitingExecution(database)
    expect(() => acceptExecution(database, { executionId: 'nope' })).toThrow(/执行不存在/)

    const running = db()
    seedWaitingExecution(running)
    /* 造一个还在跑的执行：先回到 running。 */
    let state = loadState(running)
    state = appendEvent(running, state, {
      type: 'execution.status',
      executionId: EXEC,
      to: 'running',
      at,
    }).state
    expect(() => acceptExecution(running, { executionId: 'e1' })).toThrow(/不在等待人工验收状态/)
  })
})
