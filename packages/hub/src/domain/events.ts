import type {
  Approval,
  Execution,
  ExecutionEvidence,
  Goal,
  Subtask,
  Task,
  VerificationRun,
} from './entities'
import type { ApprovalId, ExecutionId, GoalId, SubtaskId, TaskId, Timestamp } from './ids'
import type {
  ApprovalStatus,
  ExecutionStatus,
  GoalStatus,
  SubtaskStatus,
  TaskStatus,
} from './status'

/**
 * 领域事件（PRD §12 的子集，M1 只落状态机需要的部分）。
 *
 * 约定：事件是"已发生的事实"，不含推断。
 * 所有状态变更都由 applyEvent 产生，不允许外部直接改 state。
 */
export type DomainEvent =
  | { type: 'goal.created'; goal: Goal }
  | { type: 'goal.status'; goalId: GoalId; to: GoalStatus; at: Timestamp }
  | { type: 'task.created'; task: Task }
  | { type: 'task.status'; taskId: TaskId; to: TaskStatus; at: Timestamp }
  | { type: 'subtask.created'; subtask: Subtask }
  | { type: 'subtask.status'; subtaskId: SubtaskId; to: SubtaskStatus; at: Timestamp }
  | { type: 'execution.created'; execution: Execution }
  | { type: 'execution.status'; executionId: ExecutionId; to: ExecutionStatus; at: Timestamp }
  | { type: 'execution.evidence'; executionId: ExecutionId; evidence: ExecutionEvidence }
  | { type: 'verification.recorded'; run: VerificationRun }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.decided'; approvalId: ApprovalId; status: ApprovalStatus; at: Timestamp }

export type DomainEventType = DomainEvent['type']
