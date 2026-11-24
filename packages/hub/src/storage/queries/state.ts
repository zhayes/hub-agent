import type {
  Approval,
  Execution,
  Goal,
  Subtask,
  Task,
  VerificationRun,
} from '../../domain/entities'
import {
  asAgentId,
  asApprovalId,
  asExecutionId,
  asGoalId,
  asSessionId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  asVerificationRunId,
} from '../../domain/ids'
import { type DomainState, emptyState } from '../../domain/machine'
import type {
  ApprovalStatus,
  ExecutionStatus,
  GoalStatus,
  SubtaskStatus,
  TaskStatus,
} from '../../domain/status'
import type { Db } from '../db'

/**
 * 从投影表重建领域快照（只读）。
 *
 * 用途：
 *   1. Runtime 重启后取当前状态；
 *   2. `rebuild-projections --verify` 的比对基准。
 *
 * 注意：只读，不得写库（R5 的 spirit）。
 */

interface GoalRow {
  id: string
  user_id: string
  title: string
  intent: string
  status: string
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  goal_id: string
  title: string
  description: string
  status: string
  priority: number
  acceptance_criteria: string
  created_at: string
  updated_at: string
}

interface SubtaskRow {
  id: string
  task_id: string
  title: string
  description: string
  status: string
  required: number
  dependencies: string
  required_capabilities: string
  assigned_agent_id: string | null
  priority: number
  max_attempts: number
  created_at: string
  updated_at: string
}

interface ExecutionRow {
  id: string
  task_id: string
  subtask_id: string
  agent_id: string
  session_id: string | null
  status: string
  attempt: number
  evidence: string | null
  failure_category: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface VerificationRow {
  id: string
  execution_id: string
  checks: string
  verdict: string
  decided_by: string
  created_at: string
}

interface ApprovalRow {
  id: string
  task_id: string
  execution_id: string | null
  agent_id: string | null
  action: string
  resource: string
  risk_level: string
  requested_by: string
  reason: string
  decision_mode: string | null
  policy_id: string | null
  status: string
  created_at: string
  expires_at: string | null
  decided_at: string | null
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function loadState(db: Db): DomainState {
  const goals: Record<string, Goal> = {}
  for (const row of db.prepare('SELECT * FROM goals').all() as GoalRow[]) {
    goals[row.id] = {
      id: asGoalId(row.id),
      userId: row.user_id,
      title: row.title,
      intent: row.intent,
      status: row.status as GoalStatus,
      createdAt: asTimestamp(row.created_at),
      updatedAt: asTimestamp(row.updated_at),
    }
  }

  const tasks: Record<string, Task> = {}
  for (const row of db.prepare('SELECT * FROM tasks').all() as TaskRow[]) {
    tasks[row.id] = {
      id: asTaskId(row.id),
      goalId: asGoalId(row.goal_id),
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      priority: row.priority,
      acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria, []),
      createdAt: asTimestamp(row.created_at),
      updatedAt: asTimestamp(row.updated_at),
    }
  }

  const subtasks: Record<string, Subtask> = {}
  for (const row of db.prepare('SELECT * FROM subtasks').all() as SubtaskRow[]) {
    subtasks[row.id] = {
      id: asSubtaskId(row.id),
      taskId: asTaskId(row.task_id),
      title: row.title,
      description: row.description,
      status: row.status as SubtaskStatus,
      required: row.required === 1,
      dependencies: parseJson<string[]>(row.dependencies, []).map(asSubtaskId),
      requiredCapabilities: parseJson<string[]>(row.required_capabilities, []),
      ...(row.assigned_agent_id === null
        ? {}
        : { assignedAgentId: asAgentId(row.assigned_agent_id) }),
      priority: row.priority,
      maxAttempts: row.max_attempts,
      createdAt: asTimestamp(row.created_at),
      updatedAt: asTimestamp(row.updated_at),
    }
  }

  const executions: Record<string, Execution> = {}
  for (const row of db.prepare('SELECT * FROM executions').all() as ExecutionRow[]) {
    executions[row.id] = {
      id: asExecutionId(row.id),
      taskId: asTaskId(row.task_id),
      subtaskId: asSubtaskId(row.subtask_id),
      agentId: asAgentId(row.agent_id),
      ...(row.session_id === null ? {} : { sessionId: asSessionId(row.session_id) }),
      status: row.status as ExecutionStatus,
      attempt: row.attempt,
      ...(row.evidence === null ? {} : { evidence: parseJson(row.evidence, {}) }),
      ...(row.failure_category === null
        ? {}
        : { failureCategory: row.failure_category as Execution['failureCategory'] }),
      createdAt: asTimestamp(row.created_at),
      ...(row.started_at === null ? {} : { startedAt: asTimestamp(row.started_at) }),
      ...(row.finished_at === null ? {} : { finishedAt: asTimestamp(row.finished_at) }),
    }
  }

  const verifications: Record<string, VerificationRun> = {}
  for (const row of db.prepare('SELECT * FROM verification_runs').all() as VerificationRow[]) {
    verifications[row.id] = {
      id: asVerificationRunId(row.id),
      executionId: asExecutionId(row.execution_id),
      checks: parseJson(row.checks, []),
      verdict: row.verdict as VerificationRun['verdict'],
      decidedBy: row.decided_by as VerificationRun['decidedBy'],
      createdAt: asTimestamp(row.created_at),
    }
  }

  const approvals: Record<string, Approval> = {}
  for (const row of db.prepare('SELECT * FROM approvals').all() as ApprovalRow[]) {
    approvals[row.id] = {
      id: asApprovalId(row.id),
      taskId: asTaskId(row.task_id),
      ...(row.execution_id === null ? {} : { executionId: asExecutionId(row.execution_id) }),
      ...(row.agent_id === null ? {} : { agentId: asAgentId(row.agent_id) }),
      action: row.action,
      resource: row.resource,
      riskLevel: row.risk_level as Approval['riskLevel'],
      requestedBy: row.requested_by as Approval['requestedBy'],
      reason: row.reason,
      ...(row.decision_mode === null
        ? {}
        : { decisionMode: row.decision_mode as NonNullable<Approval['decisionMode']> }),
      ...(row.policy_id === null ? {} : { policyId: row.policy_id }),
      status: row.status as ApprovalStatus,
      createdAt: asTimestamp(row.created_at),
      ...(row.expires_at === null ? {} : { expiresAt: asTimestamp(row.expires_at) }),
      ...(row.decided_at === null ? {} : { decidedAt: asTimestamp(row.decided_at) }),
    }
  }

  return { ...emptyState, goals, tasks, subtasks, executions, verifications, approvals }
}
