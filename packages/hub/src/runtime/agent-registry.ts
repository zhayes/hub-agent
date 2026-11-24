import { type AgentId, asAgentId } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

export interface AgentRecord {
  id: AgentId
  name: string
  command: string
  status: string
  capabilities?: unknown
  createdAt: string
  lastSeenAt?: string
}

interface AgentRow {
  id: string
  name: string
  command: string
  status: string
  capabilities: string | null
  created_at: string
  last_seen_at: string | null
}

function toRecord(row: AgentRow): AgentRecord {
  let capabilities: unknown
  if (row.capabilities !== null) {
    try {
      capabilities = JSON.parse(row.capabilities)
    } catch {
      capabilities = undefined
    }
  }
  return {
    id: asAgentId(row.id),
    name: row.name,
    command: row.command,
    status: row.status,
    ...(capabilities === undefined ? {} : { capabilities }),
    createdAt: row.created_at,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface AddAgentInput {
  name: string
  command: string
}

/** 同一 name 重复添加时更新 command，不产生第二个 Agent。 */
export function addAgent(db: Db, input: AddAgentInput): AgentRecord {
  const name = input.name.trim()
  const command = input.command.trim()
  if (!NAME_PATTERN.test(name)) {
    throw new HubError('CONFIG_INVALID', `Agent 名称不合法：${input.name}`, { name: input.name })
  }
  if (command.length === 0) {
    throw new HubError('CONFIG_INVALID', 'Agent 启动命令不能为空', { name })
  }

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agents (id, name, command, status, capabilities, created_at, last_seen_at)
     VALUES (@id, @name, @command, 'discovered', NULL, @createdAt, NULL)
     ON CONFLICT(name) DO UPDATE SET
       command = excluded.command,
       status = 'discovered',
       capabilities = NULL,
       last_seen_at = NULL`,
  ).run({ id: newId(), name, command, createdAt: now })

  const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined
  if (row === undefined) {
    throw new HubError('DB_UNAVAILABLE', `Agent 写入后读不到：${name}`)
  }
  return toRecord(row)
}

export function listAgents(db: Db): AgentRecord[] {
  const rows = db
    .prepare('SELECT * FROM agents ORDER BY created_at ASC, id ASC')
    .all() as AgentRow[]
  return rows.map(toRecord)
}

/**
 * 解析要使用的 Agent。
 * - 指定 name：必须存在；
 * - 未指定：只有一个时直接用；多个时拒绝歧义；0 个报 NO_AGENT_AVAILABLE。
 */
export function resolveAgent(db: Db, name?: string): AgentRecord {
  if (name !== undefined) {
    const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined
    if (row === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', `没有名为 ${name} 的 Agent`, { name })
    }
    return toRecord(row)
  }

  const agents = listAgents(db)
  const first = agents[0]
  if (first === undefined) {
    throw new HubError('NO_AGENT_AVAILABLE', '没有可进行 ACP 协议连接的 Agent')
  }
  if (agents.length > 1) {
    throw new HubError('NO_AGENT_AVAILABLE', '存在多个 Agent，请用 --agent 指定', {
      agents: agents.map((agent) => agent.name),
    })
  }
  return first
}

export function markAgentSeen(
  db: Db,
  id: AgentId,
  details: { capabilities?: unknown; status?: string } = {},
): void {
  db.prepare(
    `UPDATE agents
     SET last_seen_at = @lastSeenAt,
         status = @status,
         capabilities = COALESCE(@capabilities, capabilities)
     WHERE id = @id`,
  ).run({
    id,
    lastSeenAt: new Date().toISOString(),
    status: details.status ?? 'online',
    capabilities: details.capabilities === undefined ? null : JSON.stringify(details.capabilities),
  })
}
