import { afterEach, describe, expect, it } from 'vitest'
import { addAgent, listAgents, markAgentSeen, resolveAgent } from '../../src/runtime/agent-registry'
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

describe('Agent Registry', () => {
  it('add / list / resolve 一个 Agent', () => {
    const database = db()
    const agent = addAgent(database, { name: 'codex', command: 'codex acp' })

    expect(agent.name).toBe('codex')
    expect(agent.status).toBe('discovered')
    expect(listAgents(database)).toHaveLength(1)
    expect(resolveAgent(database, 'codex').id).toBe(agent.id)
    expect(resolveAgent(database).id).toBe(agent.id)
  })

  it('同名重复添加更新命令，不产生第二个 Agent', () => {
    const database = db()
    const first = addAgent(database, { name: 'codex', command: 'old' })
    const second = addAgent(database, { name: 'codex', command: 'new' })

    expect(second.id).toBe(first.id)
    expect(second.command).toBe('new')
    expect(listAgents(database)).toHaveLength(1)
  })

  it('非法名称与空命令被拒', () => {
    const database = db()
    expect(() => addAgent(database, { name: 'bad name', command: 'x' })).toThrowError(/名称/)
    expect(() => addAgent(database, { name: 'ok', command: '   ' })).toThrowError(/不能为空/)
  })

  it('零 Agent 或多 Agent 未指定时明确报错', () => {
    const database = db()
    expect(() => resolveAgent(database)).toThrowError(/没有可进行 ACP/)

    addAgent(database, { name: 'a', command: 'a' })
    addAgent(database, { name: 'b', command: 'b' })
    expect(() => resolveAgent(database)).toThrowError(/多个 Agent/)
    expect(resolveAgent(database, 'b').name).toBe('b')
  })

  it('markAgentSeen 更新在线状态与能力', () => {
    const database = db()
    const agent = addAgent(database, { name: 'codex', command: 'codex acp' })
    markAgentSeen(database, agent.id, {
      capabilities: { loadSession: false },
      status: 'online',
    })

    const loaded = resolveAgent(database, 'codex')
    expect(loaded.status).toBe('online')
    expect(loaded.capabilities).toEqual({ loadSession: false })
    expect(loaded.lastSeenAt).toBeTruthy()
  })
})
