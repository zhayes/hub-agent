import type { Approval } from '../domain/entities'
import {
  type AgentId,
  asAgentId,
  asApprovalId,
  asExecutionId,
  asTaskId,
  asTimestamp,
  type ExecutionId,
  type TaskId,
} from '../domain/ids'
import type { DomainState } from '../domain/machine'
import type { ApprovalStatus } from '../domain/status'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'

/**
 * Approval 是“单次裁决”，不是长期策略。
 * M5 只记录决定；把批准结果自动应用到下一次执行属于策略实体（PRD §11.16），
 * 不在本里程碑伪造。
 */

export interface SandboxDeniedInput {
  taskId: TaskId | string
  executionId: ExecutionId | string
  agentId?: AgentId | string
  /** 触发拦截的命令/来源，例如 verification command 或 agent stderr */
  source: string
  /** 原始拒绝文本（截断后进 reason/resource 便于排障） */
  text: string
  decisionMode?: 'once' | 'policy'
}

const APPROVAL_TTL_MS = 60 * 60_000

export function createSandboxDeniedApproval(input: SandboxDeniedInput): Approval {
  const now = new Date()
  const decisionMode = input.decisionMode ?? 'once'
  return {
    id: asApprovalId(newId()),
    taskId: asTaskId(String(input.taskId)),
    executionId: asExecutionId(String(input.executionId)),
    ...(input.agentId === undefined ? {} : { agentId: asAgentId(String(input.agentId)) }),
    action: 'sandbox.relax',
    resource: input.source.slice(0, 500),
    riskLevel: 'medium',
    requestedBy: 'runtime',
    reason: 'sandbox_denied',
    decisionMode,
    ...(decisionMode === 'policy' ? { policyId: newId() } : {}),
    status: 'pending',
    createdAt: asTimestamp(now.toISOString()),
    expiresAt: asTimestamp(new Date(now.getTime() + APPROVAL_TTL_MS).toISOString()),
  }
}

export function getApproval(state: DomainState, approvalId: string): Approval | undefined {
  return state.approvals[approvalId]
}

export function listApprovals(db: Db): Approval[] {
  return Object.values(loadState(db).approvals).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )
}

export function decideApproval(
  db: Db,
  approvalId: string,
  status: Extract<ApprovalStatus, 'approved' | 'rejected'>,
): DomainState {
  const state = loadState(db)
  const approval = state.approvals[approvalId]
  if (approval === undefined) {
    throw new HubError('EVENT_REJECTED', `Approval 不存在：${approvalId}`, { approvalId })
  }
  if (approval.status !== 'pending') {
    throw new HubError('EVENT_REJECTED', `Approval 不是 pending：${approval.status}`, {
      approvalId,
      status: approval.status,
    })
  }
  const outcome = appendEvent(db, state, {
    type: 'approval.decided',
    approvalId: approval.id,
    status,
    at: asTimestamp(new Date().toISOString()),
  })
  return outcome.state
}
