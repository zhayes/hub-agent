import { afterEach, describe, expect, it } from 'vitest'
import { asGoalId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { createHttpApp } from '../../src/interfaces/http/app'
import { addAgent, markAgentSeen } from '../../src/runtime/agent-registry'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function seed(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  const at = asTimestamp(new Date().toISOString())
  const state = appendEvent(db, emptyState, {
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
  appendEvent(db, state, {
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
  })
  return db
}

describe('GET /api/v1/agents/presence', () => {
  it('无 token 401', async () => {
    const app = createHttpApp({ db: seed(), token: 't' })
    const response = await app.request('/api/v1/agents/presence')
    expect(response.status).toBe(401)
  })

  it('带 token 返回 asOf 与 agents；空注册表为空数组', async () => {
    const app = createHttpApp({ db: seed(), token: 't' })
    const response = await app.request('/api/v1/agents/presence', {
      headers: { authorization: 'Bearer t' },
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      ok: boolean
      asOf: string
      agents: unknown[]
    }
    expect(payload.ok).toBe(true)
    expect(typeof payload.asOf).toBe('string')
    expect(payload.agents).toEqual([])
  })

  it('返回派生 presence，且不写 agents.status', async () => {
    const db = seed()
    const record = addAgent(db, { name: 'Claude-Code', command: 'claude' })
    markAgentSeen(db, record.id, { status: 'online' })
    const app = createHttpApp({ db, token: 't' })

    const response = await app.request('/api/v1/agents/presence', {
      headers: { authorization: 'Bearer t' },
    })
    const payload = (await response.json()) as {
      agents: Array<{ id: string; presence: string; status: string }>
    }
    expect(payload.agents[0]?.presence).toBe('online')
    expect(payload.agents[0]?.status).toBe('online')

    // 查询不修改 agents.status
    const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(record.id) as {
      status: string
    }
    expect(row.status).toBe('online')
  })
})
