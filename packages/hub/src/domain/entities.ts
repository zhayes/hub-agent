import type {
  AgentId,
  ApprovalId,
  ContractId,
  ExecutionId,
  GoalId,
  SessionId,
  SubtaskId,
  TaskId,
  Timestamp,
  VerificationRunId,
} from './ids'
import type {
  ApprovalStatus,
  ExecutionStatus,
  GoalStatus,
  SubtaskStatus,
  TaskStatus,
} from './status'

export interface Goal {
  id: GoalId
  userId: string
  title: string
  /** 用户原始自然语言，不做改写 */
  intent: string
  status: GoalStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Task {
  id: TaskId
  goalId: GoalId
  title: string
  description: string
  status: TaskStatus
  priority: number
  acceptanceCriteria: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Subtask {
  id: SubtaskId
  taskId: TaskId
  title: string
  description: string
  status: SubtaskStatus
  /** 必需子任务未完成时，Task 不得 completed（不变量 I1） */
  required: boolean
  dependencies: SubtaskId[]
  requiredCapabilities: string[]
  assignedAgentId?: AgentId
  priority: number
  maxAttempts: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type VerificationKind =
  | 'command'
  | 'fileExists'
  | 'diffScope'
  | 'noUnexpectedChange'
  | 'llmReview'

/** 可执行验收检查（PRD §6.7.5）。自然语言不能单独作为验收条件。 */
export type VerificationCheck =
  | {
      kind: 'command'
      cmd: string
      timeoutMs: number
      expect: { exitCode: number | number[] }
    }
  | { kind: 'fileExists'; path: string }
  | { kind: 'diffScope'; allowedPaths: string[] }
  | { kind: 'noUnexpectedChange'; paths: string[] }
  | { kind: 'llmReview'; rubric: string; evidenceRefs: string[] }

export interface VerificationCheckResult {
  checkId: string
  kind: VerificationKind
  passed: boolean
  command?: string
  exitCode?: number
  /** 大文本一律存引用，不内联 */
  outputRef?: string
  durationMs?: number
  /** llmReview 等无法自动判定的检查；verdict 会变成 manual_required */
  manualRequired?: boolean
}

export interface ExecutionEvidence {
  branch?: string
  commitSha?: string
  diffstat?: string
  changedFiles?: string[]
  transcriptRef?: string
  /**
   * Agent 本轮自己交回的最终回答（不是 transcript 全文，也不是自述式验收）。
   * 只读任务（review、分析）的“产物”就在这里；截断上限由 Runtime 控制。
   */
  result?: string
  diff?: string
  diffTruncated?: boolean
}

export type FailureCategory = 'protocol' | 'agent' | 'resource' | 'verification' | 'budget'

export interface Execution {
  id: ExecutionId
  taskId: TaskId
  subtaskId: SubtaskId
  agentId: AgentId
  sessionId?: SessionId
  status: ExecutionStatus
  attempt: number
  evidence?: ExecutionEvidence
  failureCategory?: FailureCategory
  createdAt: Timestamp
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

export type VerificationVerdict = 'pass' | 'fail' | 'manual_required'

export interface VerificationRun {
  id: VerificationRunId
  executionId: ExecutionId
  checks: VerificationCheckResult[]
  verdict: VerificationVerdict
  decidedBy: 'runtime' | 'brain' | 'human'
  createdAt: Timestamp
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface Approval {
  id: ApprovalId
  taskId: TaskId
  executionId?: ExecutionId
  agentId?: AgentId
  action: string
  resource: string
  riskLevel: RiskLevel
  requestedBy: 'brain' | 'runtime' | 'agent'
  reason: string
  /** once = 仅本次；policy = 按策略长期生效 */
  decisionMode?: 'once' | 'policy'
  policyId?: string
  status: ApprovalStatus
  createdAt: Timestamp
  expiresAt?: Timestamp
  decidedAt?: Timestamp
}

/** 交给 Agent 的上下文包（ARCHITECTURE §6.11） */
export interface TaskBrief {
  objective: string
  constraints: string[]
  contextRefs: string[]
  existingConventions: string[]
  acceptance: string[]
  outOfScope: string[]
  knownPitfalls: string[]
}

export interface DelegationContract {
  id: ContractId
  subtaskId: SubtaskId
  executionId?: ExecutionId
  requirements: {
    capabilities: string[]
    minReliability?: number
    /** 仅偏好，不构成强制路由（§6.6.6） */
    preferredAgentId?: AgentId
  }
  brief: TaskBrief
  workspace: {
    projectId: string
    isolation: 'shared' | 'worktree' | 'copy'
    allowedPaths: string[]
    baseRef?: string
  }
  budget: {
    maxWallClockMs: number
    maxTokens?: number
    maxCostUsd?: number
  }
  policy: {
    allowRedelegate: boolean
    requiresApproval: boolean
    captureTranscript: boolean
  }
  idempotencyKey: string
  expiresAt?: Timestamp
}

/**
 * 不变量 I3 的判定口径：证据必须是"实质内容"，
 * 空的 evidence 对象不算有证据。
 */
export function hasEvidence(evidence: ExecutionEvidence | undefined): boolean {
  if (evidence === undefined) return false
  return (
    (evidence.commitSha !== undefined && evidence.commitSha.length > 0) ||
    (evidence.diffstat !== undefined && evidence.diffstat.length > 0) ||
    (evidence.transcriptRef !== undefined && evidence.transcriptRef.length > 0) ||
    (evidence.changedFiles !== undefined && evidence.changedFiles.length > 0)
  )
}

export function isVerified(run: VerificationRun): boolean {
  return run.verdict === 'pass' || run.verdict === 'manual_required'
}
