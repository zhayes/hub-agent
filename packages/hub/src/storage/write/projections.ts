import type {
  Approval,
  Execution,
  Goal,
  Subtask,
  Task,
  VerificationRun,
} from '../../domain/entities'
import type { DomainEvent } from '../../domain/events'
import type { DomainState } from '../../domain/machine'
import type { Db } from '../db'

/**
 * 投影写入：事件与实体表在同一事务里更新（ARCHITECTURE §6.4）。
 *
 * 实体表就是投影表——不再额外建 *_view，避免两份命名互相漂移。
 */
export function upsertAggregate(db: Db, event: DomainEvent, next: DomainState): void {
  switch (event.type) {
    case 'goal.created': {
      const id = event.goal.id
      const goal = next.goals[id]
      if (goal !== undefined) upsertGoal(db, goal)
      return
    }
    case 'goal.status': {
      const goal = next.goals[event.goalId]
      if (goal !== undefined) upsertGoal(db, goal)
      return
    }
    case 'task.created': {
      const task = next.tasks[event.task.id]
      if (task !== undefined) upsertTask(db, task)
      return
    }
    case 'task.status': {
      const task = next.tasks[event.taskId]
      if (task !== undefined) upsertTask(db, task)
      return
    }
    case 'subtask.created': {
      const subtask = next.subtasks[event.subtask.id]
      if (subtask !== undefined) upsertSubtask(db, subtask)
      return
    }
    case 'subtask.assigned': {
      const subtask = next.subtasks[event.subtaskId]
      if (subtask !== undefined) upsertSubtask(db, subtask)
      return
    }
    case 'subtask.status': {
      const subtask = next.subtasks[event.subtaskId]
      if (subtask !== undefined) upsertSubtask(db, subtask)
      return
    }
    case 'execution.created': {
      const execution = next.executions[event.execution.id]
      if (execution !== undefined) upsertExecution(db, execution)
      return
    }
    case 'execution.status':
    case 'execution.evidence': {
      const execution = next.executions[event.executionId]
      if (execution !== undefined) upsertExecution(db, execution)
      return
    }
    case 'verification.recorded': {
      const run = next.verifications[event.run.id]
      if (run !== undefined) insertVerification(db, run)
      return
    }
    case 'approval.requested':
    case 'approval.decided': {
      const id = event.type === 'approval.requested' ? event.approval.id : event.approvalId
      const approval = next.approvals[id]
      if (approval !== undefined) upsertApproval(db, approval)
      return
    }
    default: {
      // 穷尽性保险：新增事件类型时这里必须编译失败，不能静默漏写投影
      const exhaustive: never = event
      throw new Error(`未处理的投影事件：${JSON.stringify(exhaustive)}`)
    }
  }
}

export function upsertGoal(db: Db, goal: Goal): void {
  db.prepare(
    `INSERT INTO goals (id, user_id, title, intent, status, created_at, updated_at)
     VALUES (@id, @userId, @title, @intent, @status, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       title = excluded.title,
       intent = excluded.intent,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run({
    id: goal.id,
    userId: goal.userId,
    title: goal.title,
    intent: goal.intent,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  })
}

export function upsertTask(db: Db, task: Task): void {
  db.prepare(
    `INSERT INTO tasks (id, goal_id, title, description, status, priority, acceptance_criteria, created_at, updated_at)
     VALUES (@id, @goalId, @title, @description, @status, @priority, @acceptanceCriteria, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       status = excluded.status,
       priority = excluded.priority,
       acceptance_criteria = excluded.acceptance_criteria,
       updated_at = excluded.updated_at`,
  ).run({
    id: task.id,
    goalId: task.goalId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    acceptanceCriteria: JSON.stringify(task.acceptanceCriteria),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })
}

export function upsertSubtask(db: Db, subtask: Subtask): void {
  db.prepare(
    `INSERT INTO subtasks (
       id, task_id, title, description, status, required, dependencies,
       required_capabilities, assigned_agent_id, priority, max_attempts, created_at, updated_at
     ) VALUES (
       @id, @taskId, @title, @description, @status, @required, @dependencies,
       @requiredCapabilities, @assignedAgentId, @priority, @maxAttempts, @createdAt, @updatedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       status = excluded.status,
       required = excluded.required,
       dependencies = excluded.dependencies,
       required_capabilities = excluded.required_capabilities,
       assigned_agent_id = excluded.assigned_agent_id,
       priority = excluded.priority,
       max_attempts = excluded.max_attempts,
       updated_at = excluded.updated_at`,
  ).run({
    id: subtask.id,
    taskId: subtask.taskId,
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    required: subtask.required ? 1 : 0,
    dependencies: JSON.stringify(subtask.dependencies),
    requiredCapabilities: JSON.stringify(subtask.requiredCapabilities),
    assignedAgentId: subtask.assignedAgentId ?? null,
    priority: subtask.priority,
    maxAttempts: subtask.maxAttempts,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
  })
}

export function upsertExecution(db: Db, execution: Execution): void {
  db.prepare(
    `INSERT INTO executions (
       id, task_id, subtask_id, agent_id, session_id, status, attempt,
       evidence, failure_category, created_at, started_at, finished_at
     ) VALUES (
       @id, @taskId, @subtaskId, @agentId, @sessionId, @status, @attempt,
       @evidence, @failureCategory, @createdAt, @startedAt, @finishedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       status = excluded.status,
       evidence = excluded.evidence,
       failure_category = excluded.failure_category,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at`,
  ).run({
    id: execution.id,
    taskId: execution.taskId,
    subtaskId: execution.subtaskId,
    agentId: execution.agentId,
    sessionId: execution.sessionId ?? null,
    status: execution.status,
    attempt: execution.attempt,
    evidence: execution.evidence === undefined ? null : JSON.stringify(execution.evidence),
    failureCategory: execution.failureCategory ?? null,
    createdAt: execution.createdAt,
    startedAt: execution.startedAt ?? null,
    finishedAt: execution.finishedAt ?? null,
  })
}

export function insertVerification(db: Db, run: VerificationRun): void {
  db.prepare(
    `INSERT INTO verification_runs (id, execution_id, checks, verdict, decided_by, created_at)
     VALUES (@id, @executionId, @checks, @verdict, @decidedBy, @createdAt)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: run.id,
    executionId: run.executionId,
    checks: JSON.stringify(run.checks),
    verdict: run.verdict,
    decidedBy: run.decidedBy,
    createdAt: run.createdAt,
  })
}

export function upsertApproval(db: Db, approval: Approval): void {
  db.prepare(
    `INSERT INTO approvals (
       id, task_id, execution_id, agent_id, action, resource, risk_level,
       requested_by, reason, decision_mode, policy_id, status, created_at, expires_at, decided_at
     ) VALUES (
       @id, @taskId, @executionId, @agentId, @action, @resource, @riskLevel,
       @requestedBy, @reason, @decisionMode, @policyId, @status, @createdAt, @expiresAt, @decidedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       decision_mode = excluded.decision_mode,
       policy_id = excluded.policy_id,
       expires_at = excluded.expires_at,
       decided_at = excluded.decided_at`,
  ).run({
    id: approval.id,
    taskId: approval.taskId,
    executionId: approval.executionId ?? null,
    agentId: approval.agentId ?? null,
    action: approval.action,
    resource: approval.resource,
    riskLevel: approval.riskLevel,
    requestedBy: approval.requestedBy,
    reason: approval.reason,
    decisionMode: approval.decisionMode ?? null,
    policyId: approval.policyId ?? null,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt ?? null,
    decidedAt: approval.decidedAt ?? null,
  })
}
