import type { Db } from '../db'

/**
 * Agent presence 读模型（PLAN-AGENT-OFFICE §3.1 / §3.2）。
 *
 * 只读：联表 agents × executions × subtasks × tasks × pending approvals × last event，
 * 派生出 UI 需要的 presence。**不写库、不改 agents.status**（R5 与「数据诚实」）。
 *
 * 派生规则见 §3.2：disabled > error > degraded > offline > starting/initializing
 * > 无握手记录 → discovered > 有活跃执行 → busy > 其余 online。
 */

export const PRESENCE_STATES = [
  'discovered',
  'starting',
  'initializing',
  'online',
  'busy',
  'degraded',
  'offline',
  'error',
  'disabled',
] as const

export type PresenceState = (typeof PRESENCE_STATES)[number]

/** 占用进程、代表「正在做事」的执行状态（paused 不在其中，见 domain/status.ts）。 */
const ACTIVE_EXECUTION_STATUSES: readonly string[] = [
  'starting',
  'running',
  'waiting_permission',
  'waiting_input',
]

export interface AgentActivityView {
  executionId: string
  executionStatus: string
  taskId: string
  taskTitle: string
  subtaskId: string
  subtaskTitle: string
  /** 主执行对应子任务在计划里的序号（1 起）；无法确定时省略。 */
  step?: number
  /** 计划子任务总数；无法确定时省略。 */
  steps?: number
  attempt: number
  startedAt?: string
  waitingOn: 'permission' | 'input' | null
}

export interface AgentApprovalView {
  id: string
  resource: string
  riskLevel: string
  requestedAt: string
}

export interface AgentLastEventView {
  type: string
  at: string
}

export interface AgentPresenceView {
  id: string
  name: string
  /** agents 表的原始 status（不派生、不修改）。 */
  status: string
  presence: PresenceState
  lastSeenAt?: string
  networkMode: string
  allowedWrite: string[]
  allowedDomains: string[]
  /** Agent 自称的能力；抽屉里标注「未验证」。 */
  capabilities: string[]
  activity?: AgentActivityView
  /** 主执行之外的活跃执行数。 */
  parallelCount: number
  pendingApprovals: AgentApprovalView[]
  lastEvent?: AgentLastEventView
}

export interface AgentPresenceSnapshot {
  asOf: string
  agents: AgentPresenceView[]
}

export interface DerivePresenceInput {
  /** agents.status 原值 */
  status: string
  lastSeenAt?: string
  hasActiveExecution: boolean
}

/**
 * 纯派生：给定 agents.status + 是否握手过 + 是否有活跃执行，得出 presence。
 * 顺序即优先级，和 §3.2 的表格逐行对应。
 */
export function derivePresence(input: DerivePresenceInput): PresenceState {
  const status = input.status
  if (status === 'disabled') return 'disabled'
  if (status === 'error') return 'error'
  if (status === 'degraded') return 'degraded'
  if (status === 'offline') return 'offline'
  if (status === 'starting') return 'starting'
  if (status === 'initializing') return 'initializing'
  if (input.lastSeenAt === undefined) return 'discovered'
  if (input.hasActiveExecution) return 'busy'
  return 'online'
}

interface AgentRow {
  id: string
  name: string
  status: string
  network_mode: string | null
  allowed_domains: string | null
  allowed_write: string | null
  capabilities: string | null
  created_at: string
  last_seen_at: string | null
}

interface ExecutionRow {
  id: string
  task_id: string
  subtask_id: string
  agent_id: string
  status: string
  attempt: number
  created_at: string
  started_at: string | null
}

interface SubtaskRow {
  id: string
  task_id: string
  title: string
  created_at: string
}

interface TaskRow {
  id: string
  title: string
}

interface ApprovalRow {
  id: string
  agent_id: string | null
  resource: string
  risk_level: string
  status: string
  created_at: string
}

function parseStringArray(value: string | null): string[] {
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

function executionOrder(a: ExecutionRow): string {
  return a.started_at ?? a.created_at
}

function isActive(status: string): boolean {
  return ACTIVE_EXECUTION_STATUSES.includes(status)
}

function waitingOnOf(status: string): AgentActivityView['waitingOn'] {
  if (status === 'waiting_permission') return 'permission'
  if (status === 'waiting_input') return 'input'
  return null
}

/**
 * 选择「主执行」：
 *   1. 活跃执行（starting/running/waiting_permission/waiting_input），最近开始的优先；
 *   2. 否则 paused 执行（保留现场，用于展示暂停态）；
 *   3. 都没有则 activity 省略。
 */
function primaryExecution(executions: readonly ExecutionRow[]): ExecutionRow | undefined {
  const sorted = [...executions].sort((a, b) => executionOrder(b).localeCompare(executionOrder(a)))
  return (
    sorted.find((execution) => isActive(execution.status)) ??
    sorted.find((e) => e.status === 'paused')
  )
}

export function listAgentPresence(db: Db, now: Date = new Date()): AgentPresenceSnapshot {
  const agentRows = db
    .prepare('SELECT * FROM agents ORDER BY created_at ASC, id ASC')
    .all() as AgentRow[]

  if (agentRows.length === 0) {
    return { asOf: now.toISOString(), agents: [] }
  }

  const executionRows = db
    .prepare(
      `SELECT id, task_id, subtask_id, agent_id, status, attempt, created_at, started_at
       FROM executions`,
    )
    .all() as ExecutionRow[]
  const subtaskRows = db
    .prepare('SELECT id, task_id, title, created_at FROM subtasks')
    .all() as SubtaskRow[]
  const taskRows = db.prepare('SELECT id, title FROM tasks').all() as TaskRow[]
  const approvalRows = db
    .prepare(
      `SELECT id, agent_id, resource, risk_level, status, created_at
       FROM approvals WHERE agent_id IS NOT NULL`,
    )
    .all() as ApprovalRow[]

  const executionsByAgent = new Map<string, ExecutionRow[]>()
  for (const execution of executionRows) {
    const bucket = executionsByAgent.get(execution.agent_id)
    if (bucket === undefined) executionsByAgent.set(execution.agent_id, [execution])
    else bucket.push(execution)
  }

  const subtasksByTask = new Map<string, SubtaskRow[]>()
  const subtaskTitles = new Map<string, string>()
  for (const subtask of subtaskRows) {
    subtaskTitles.set(subtask.id, subtask.title)
    const bucket = subtasksByTask.get(subtask.task_id)
    if (bucket === undefined) subtasksByTask.set(subtask.task_id, [subtask])
    else bucket.push(subtask)
  }

  const taskTitles = new Map<string, string>()
  for (const task of taskRows) taskTitles.set(task.id, task.title)

  const approvalsByAgent = new Map<string, ApprovalRow[]>()
  for (const approval of approvalRows) {
    if (approval.agent_id === null) continue
    const bucket = approvalsByAgent.get(approval.agent_id)
    if (bucket === undefined) approvalsByAgent.set(approval.agent_id, [approval])
    else bucket.push(approval)
  }

  /* last event 用 prepared statement，按 agent 的 execution/approval 聚合取最近一条。 */
  const lastEventStatement = db.prepare(
    `SELECT type, at FROM events
     WHERE (aggregate_type = 'execution'
              AND aggregate_id IN (SELECT id FROM executions WHERE agent_id = @agentId))
        OR (aggregate_type = 'approval'
              AND aggregate_id IN (SELECT id FROM approvals WHERE agent_id = @agentId))
     ORDER BY seq DESC LIMIT 1`,
  )

  const agents = agentRows.map((row): AgentPresenceView => {
    const executions = executionsByAgent.get(row.id) ?? []
    const activeExecutions = executions.filter((execution) => isActive(execution.status))
    const primary = primaryExecution(executions)
    const lastSeenAt = row.last_seen_at ?? undefined

    const presence = derivePresence({
      status: row.status,
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      hasActiveExecution: activeExecutions.length > 0,
    })

    let activity: AgentActivityView | undefined
    if (primary !== undefined) {
      const siblings = subtasksByTask.get(primary.task_id) ?? []
      const ordered = [...siblings].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      )
      const index = ordered.findIndex((subtask) => subtask.id === primary.subtask_id)
      activity = {
        executionId: primary.id,
        executionStatus: primary.status,
        taskId: primary.task_id,
        taskTitle: taskTitles.get(primary.task_id) ?? '',
        subtaskId: primary.subtask_id,
        subtaskTitle: subtaskTitles.get(primary.subtask_id) ?? '',
        ...(index >= 0 && ordered.length > 0 ? { step: index + 1, steps: ordered.length } : {}),
        attempt: primary.attempt,
        ...(primary.started_at === null ? {} : { startedAt: primary.started_at }),
        waitingOn: waitingOnOf(primary.status),
      }
    }

    const primaryIsActive = primary !== undefined && isActive(primary.status)
    const parallelCount = Math.max(0, activeExecutions.length - (primaryIsActive ? 1 : 0))

    const approvals = (approvalsByAgent.get(row.id) ?? [])
      .filter((approval) => approval.status === 'pending')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(
        (approval): AgentApprovalView => ({
          id: approval.id,
          resource: approval.resource,
          riskLevel: approval.risk_level,
          requestedAt: approval.created_at,
        }),
      )

    const lastEvent =
      executions.length > 0 || (approvalsByAgent.get(row.id)?.length ?? 0) > 0
        ? (lastEventStatement.get({ agentId: row.id }) as { type: string; at: string } | undefined)
        : undefined

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      presence,
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      networkMode: row.network_mode ?? 'agent-managed',
      allowedWrite: parseStringArray(row.allowed_write),
      allowedDomains: parseStringArray(row.allowed_domains),
      capabilities: parseStringArray(row.capabilities),
      ...(activity === undefined ? {} : { activity }),
      parallelCount,
      pendingApprovals: approvals,
      ...(lastEvent === undefined ? {} : { lastEvent }),
    }
  })

  return { asOf: now.toISOString(), agents }
}
