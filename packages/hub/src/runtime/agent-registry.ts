import { isAbsolute } from 'node:path'
import { type AgentId, asAgentId } from '../domain/ids'
import type { SandboxNetworkMode } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

export interface AgentRecord {
  id: AgentId
  name: string
  command: string
  status: string
  /** 默认 agent-managed：Agent 自己负责模型/外部网络；文件边界仍由 HubAgent 强制 */
  networkMode: SandboxNetworkMode
  allowedDomains: string[]
  allowedWrite: string[]
  capabilities?: unknown
  createdAt: string
  lastSeenAt?: string
}

interface AgentRow {
  id: string
  name: string
  command: string
  status: string
  network_mode: string
  allowed_domains: string | null
  allowed_write: string | null
  capabilities: string | null
  created_at: string
  last_seen_at: string | null
}

function parseStrings(value: string | null): string[] {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
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
    networkMode: (row.network_mode as SandboxNetworkMode | undefined) ?? 'agent-managed',
    allowedDomains: parseStrings(row.allowed_domains),
    allowedWrite: parseStrings(row.allowed_write),
    ...(capabilities === undefined ? {} : { capabilities }),
    createdAt: row.created_at,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface AddAgentInput {
  name: string
  command: string
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  allowedWrite?: readonly string[]
}

function normalizeNetworkMode(input: AddAgentInput): SandboxNetworkMode {
  const mode =
    input.networkMode ?? ((input.allowedDomains?.length ?? 0) > 0 ? 'allowlist' : 'agent-managed')
  if (mode === 'agent-managed' && (input.allowedDomains?.length ?? 0) > 0) {
    throw new HubError(
      'CONFIG_INVALID',
      'networkMode=agent-managed 时不能声明 allowedDomains；需要白名单请用 allowlist',
    )
  }
  if (mode === 'deny' && (input.allowedDomains?.length ?? 0) > 0) {
    throw new HubError('CONFIG_INVALID', 'networkMode=deny 时不能声明 allowedDomains')
  }
  for (const path of input.allowedWrite ?? []) {
    if (!isAbsolute(path)) {
      throw new HubError('CONFIG_INVALID', `allowedWrite 必须是绝对路径：${path}`, { path })
    }
  }
  return mode
}

/** 同一 name 重复添加时更新 profile，不产生第二个 Agent。 */
export function addAgent(db: Db, input: AddAgentInput): AgentRecord {
  const name = input.name.trim()
  const command = input.command.trim()
  if (!NAME_PATTERN.test(name)) {
    throw new HubError('CONFIG_INVALID', `Agent 名称不合法：${input.name}`, { name: input.name })
  }
  if (command.length === 0) {
    throw new HubError('CONFIG_INVALID', 'Agent 启动命令不能为空', { name })
  }

  const networkMode = normalizeNetworkMode(input)
  const allowedDomains = [...new Set(input.allowedDomains ?? [])]
  const allowedWrite = [...new Set(input.allowedWrite ?? [])]
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO agents (
       id, name, command, status, network_mode, allowed_domains, allowed_write,
       capabilities, created_at, last_seen_at
     ) VALUES (
       @id, @name, @command, 'discovered', @networkMode, @allowedDomains, @allowedWrite,
       NULL, @createdAt, NULL
     )
     ON CONFLICT(name) DO UPDATE SET
       command = excluded.command,
       status = 'discovered',
       network_mode = excluded.network_mode,
       allowed_domains = excluded.allowed_domains,
       allowed_write = excluded.allowed_write,
       capabilities = NULL,
       last_seen_at = NULL`,
  ).run({
    id: newId(),
    name,
    command,
    networkMode,
    allowedDomains: JSON.stringify(allowedDomains),
    allowedWrite: JSON.stringify(allowedWrite),
    createdAt: now,
  })

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
