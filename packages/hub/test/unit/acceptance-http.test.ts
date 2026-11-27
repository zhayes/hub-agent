import { afterEach, describe, expect, it } from 'vitest'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { createHttpApp } from '../../src/interfaces/http/app'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { loadState } from '../../src/storage/queries/state'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []
const TOKEN = 'test-token'

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

const at = asTimestamp('2026-01-01T00:00:00.000Z')
const GOAL = asGoalId('g1')
const TASK = asTaskId('t1')
const SUBTASK = asSubtaskId('s1')
const EXEC = asExecutionId('e1')

/** 造一个停在 waiting_input 的执行（人工验收入口）。 */
function seed(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)

  let state = loadState(db)
  for (const event of [
    {
      type: 'goal.created' as const,
      goal: {
        id: GOAL,
        userId: 'local',
        title: '目标',
        intent: '意图',
        status: 'active' as const,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      type: 'task.created' as const,
      task: {
        id: TASK,
        goalId: GOAL,
        title: '任务',
        description: '描述',
        status: 'draft' as const,
        priority: 0,
        acceptanceCriteria: ['可验收'],
        createdAt: at,
        updatedAt: at,
      },
    },
    { type: 'task.status' as const, taskId: TASK, to: 'planning' as const, at },
    { type: 'task.status' as const, taskId: TASK, to: 'ready' as const, at },
    { type: 'task.status' as const, taskId: TASK, to: 'running' as const, at },
    {
      type: 'subtask.created' as const,
      subtask: {
        id: SUBTASK,
        taskId: TASK,
        title: '子任务',
        description: '做事',
        status: 'ready' as const,
        required: true,
        dependencies: [],
        requiredCapabilities: [],
        priority: 0,
        maxAttempts: 1,
        createdAt: at,
        updatedAt: at,
      },
    },
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
    state = appendEvent(db, state, event).state
  }
  return db
}

function post(app: ReturnType<typeof createHttpApp>, path: string, body?: unknown, token = TOKEN) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('人工验收 HTTP 入口', () => {
  it('未认证被拒', async () => {
    const app = createHttpApp({ db: seed(), token: TOKEN })
    const response = await app.request('/api/v1/executions/e1/accept', { method: 'POST' })
    expect(response.status).toBe(401)
  })

  it('accept → 200，执行收敛为 succeeded', async () => {
    const db = seed()
    const app = createHttpApp({ db, token: TOKEN })

    const response = await post(app, '/api/v1/executions/e1/accept', { note: '看过了' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; verdict: string; goalId: string }
    expect(body.ok).toBe(true)
    expect(body.verdict).toBe('pass')
    expect(body.goalId).toBe('g1')
    expect(loadState(db).executions[EXEC]?.status).toBe('succeeded')
  })

  it('重复 accept → 409（已不在等待态）', async () => {
    const app = createHttpApp({ db: seed(), token: TOKEN })
    expect((await post(app, '/api/v1/executions/e1/accept')).status).toBe(200)
    expect((await post(app, '/api/v1/executions/e1/accept')).status).toBe(409)
  })

  it('reject → 200 且三态收敛为 failed', async () => {
    const db = seed()
    const app = createHttpApp({ db, token: TOKEN })

    const response = await post(app, '/api/v1/executions/e1/reject', { reason: '产物不对' })
    expect(response.status).toBe(200)
    const state = loadState(db)
    expect(state.executions[EXEC]?.status).toBe('failed')
    expect(state.subtasks[SUBTASK]?.status).toBe('failed')
    expect(state.tasks[TASK]?.status).toBe('failed')
  })
})
