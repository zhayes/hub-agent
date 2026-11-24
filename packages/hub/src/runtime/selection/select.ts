import { HubError } from '../../shared/errors'
import type { Db } from '../../storage/db'
import type { AgentRecord } from '../agent-registry'

export interface SelectionInput {
  agents: readonly AgentRecord[]
  requiredCapabilities?: readonly string[]
  excludeAgentIds?: readonly string[]
}

export interface AgentScore {
  agent: AgentRecord
  score: number
  reliability: number
  activeLoad: number
  capabilityMatch: boolean
  reasons: string[]
}

interface AgentStats {
  total: number
  succeeded: number
  active: number
}

/**
 * 确定性 Selection Engine：
 *   - 排除 offline/error 与显式排除的 Agent；
 *   - 历史成功率（无历史按 0.5）；
 *   - 活跃执行负载惩罚；
 *   - requiredCapabilities 匹配加分，不匹配不硬拒绝（真实 harness 能力常未声明）。
 *
 * 分数固定、排序固定，便于重放与解释。
 */
export function rankAgents(db: Db, input: SelectionInput): AgentScore[] {
  const excluded = new Set(input.excludeAgentIds ?? [])
  const stats = loadStats(db)
  const required = input.requiredCapabilities ?? []

  return input.agents
    .filter((agent) => agent.status !== 'offline' && agent.status !== 'error')
    .filter((agent) => !excluded.has(agent.id))
    .map((agent) => scoreAgent(agent, stats.get(agent.id), required))
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id))
}

export function selectAgent(db: Db, input: SelectionInput): AgentRecord {
  const ranked = rankAgents(db, input)
  const first = ranked[0]
  if (first === undefined) {
    throw new HubError('NO_AGENT_AVAILABLE', '没有满足条件的可用 Agent', {
      requiredCapabilities: input.requiredCapabilities ?? [],
      excluded: input.excludeAgentIds ?? [],
    })
  }
  return first.agent
}

export function scoreAgent(
  agent: AgentRecord,
  stats: AgentStats | undefined,
  requiredCapabilities: readonly string[],
): AgentScore {
  const total = stats?.total ?? 0
  const succeeded = stats?.succeeded ?? 0
  const reliability = total === 0 ? 0.5 : succeeded / total
  const activeLoad = stats?.active ?? 0
  const declared = capabilitiesOf(agent)
  const capabilityMatch =
    requiredCapabilities.length === 0 ||
    requiredCapabilities.every((capability) => declared.includes(capability))
  const statusBonus = agent.status === 'online' ? 8 : agent.status === 'discovered' ? 2 : 0
  const score = reliability * 100 + statusBonus + (capabilityMatch ? 20 : 0) - activeLoad * 15
  const reasons = [
    `reliability=${reliability.toFixed(2)}`,
    `active=${activeLoad}`,
    capabilityMatch ? 'capabilities=match' : 'capabilities=unknown',
    `status=${agent.status}`,
  ]
  return {
    agent,
    score: Math.round(score * 100) / 100,
    reliability,
    activeLoad,
    capabilityMatch,
    reasons,
  }
}

function capabilitiesOf(agent: AgentRecord): string[] {
  if (Array.isArray(agent.capabilities)) {
    return agent.capabilities.filter((item): item is string => typeof item === 'string')
  }
  return []
}

function loadStats(db: Db): Map<string, AgentStats> {
  const rows = db
    .prepare(
      `SELECT agent_id,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status IN ('starting','running','waiting_permission','waiting_input') THEN 1 ELSE 0 END) AS active
       FROM executions GROUP BY agent_id`,
    )
    .all() as Array<{ agent_id: string; total: number; succeeded: number; active: number }>
  return new Map(
    rows.map((row) => [
      row.agent_id,
      { total: row.total, succeeded: row.succeeded, active: row.active },
    ]),
  )
}
