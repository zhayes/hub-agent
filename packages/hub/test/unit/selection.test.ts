import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRecord } from '../../src/runtime/agent-registry'
import { rankAgents, selectAgent } from '../../src/runtime/selection/select'
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

function seedRefs(database: Db): void {
  const at = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO goals (id, user_id, title, intent, status, created_at, updated_at)
       VALUES ('g1','local','g','g','active',@at,@at)`,
    )
    .run({ at })
  database
    .prepare(
      `INSERT INTO tasks (id, goal_id, title, description, status, priority, acceptance_criteria, created_at, updated_at)
       VALUES ('t1','g1','t','t','running',0,'[]',@at,@at)`,
    )
    .run({ at })
  database
    .prepare(
      `INSERT INTO subtasks (id, task_id, title, description, status, required, dependencies, required_capabilities, assigned_agent_id, priority, max_attempts, created_at, updated_at)
       VALUES ('s1','t1','s','s','running',1,'[]','[]','a1',0,1,@at,@at)`,
    )
    .run({ at })
}

function agent(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: id as AgentRecord['id'],
    name: id,
    command: 'x',
    status: 'online',
    networkMode: 'agent-managed',
    allowedDomains: [],
    allowedWrite: [],
    capabilities: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('Selection Engine', () => {
  it('按历史成功率与负载排序，排除 offline', () => {
    const database = db()
    seedRefs(database)
    database
      .prepare(
        `INSERT INTO executions (id, task_id, subtask_id, agent_id, status, attempt, created_at)
         VALUES ('e1','t1','s1','a1','succeeded',1,@at),
                ('e2','t1','s1','a1','failed',2,@at),
                ('e3','t1','s1','a2','succeeded',1,@at)`,
      )
      .run({ at: new Date().toISOString() })
    const ranked = rankAgents(database, {
      agents: [agent('a1'), agent('a2'), agent('offline', { status: 'offline' })],
    })
    expect(ranked.map((item) => item.agent.id)).toEqual(['a2', 'a1'])
    expect(ranked[0]?.reliability).toBe(1)
    expect(ranked[1]?.reliability).toBe(0.5)
  })

  it('requiredCapabilities 匹配加分；显式排除生效', () => {
    const database = db()
    const agents = [
      agent('a1', { capabilities: ['code'] }),
      agent('a2', { capabilities: ['code', 'test'] }),
    ]
    const selected = selectAgent(database, {
      agents,
      requiredCapabilities: ['test'],
      excludeAgentIds: ['a2'],
    })
    expect(selected.id).toBe('a1')
  })

  it('没有可用 Agent 时报 NO_AGENT_AVAILABLE', () => {
    const database = db()
    expect(() =>
      selectAgent(database, { agents: [agent('a1', { status: 'offline' })] }),
    ).toThrowError(/没有满足条件/)
  })
})
