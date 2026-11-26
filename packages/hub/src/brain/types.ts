import type { ApprovalStatus, ExecutionStatus, SubtaskStatus, TaskStatus } from '../domain/status'

/**
 * Brain 层契约（PRD §6.10 / ARCHITECTURE §5）。
 *
 * 这个目录只能看到渲染好的快照与结构化 intent，拿不到 DB、文件或 shell。
 */

export interface BrainBudget {
  /** 单回合最大动作数 */
  maxActions: number
  /** 单回合输入 token 估算上限 */
  maxInputTokens: number
  /** 单回合输出 token 上限（当前用于约束/记录，不强制截断） */
  maxOutputTokens: number
  /** 单回合墙钟超时 */
  timeoutMs: number
}

export const DEFAULT_BRAIN_BUDGET: BrainBudget = {
  maxActions: 16,
  maxInputTokens: 32_000,
  maxOutputTokens: 4_000,
  timeoutMs: 90_000,
}

export interface AgentSummary {
  id: string
  name: string
  status: string
  capabilities?: unknown
}

export interface ExecutionView {
  id: string
  status: ExecutionStatus
  evidence?: {
    branch?: string
    commitSha?: string
    diffstat?: string
    changedFiles?: string[]
    transcriptRef?: string
  }
  verification?: {
    verdict: 'pass' | 'fail' | 'manual_required'
  }
}

export interface SubtaskView {
  id: string
  title: string
  description: string
  status: SubtaskStatus
  required: boolean
  execution?: ExecutionView
}

export interface TaskView {
  id: string
  title: string
  status: TaskStatus
  subtasks: SubtaskView[]
}

export interface PendingDecisionView {
  id: string
  reason: string
  createdAt: string
}

/** 控制台对话的最近若干轮；只带用户可见文本，不带工具流水。 */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface BrainInput {
  goal: {
    id: string
    title: string
    intent: string
    status: string
  }
  planRevision: number
  /** Chat 入口的对话历史；`hubagent run` 等任务路径不传。 */
  conversation?: ChatTurn[]
  tasks: TaskView[]
  agents: AgentSummary[]
  pending: PendingDecisionView[]
  approvals: Array<{
    id: string
    status: ApprovalStatus
    reason: string
    resource: string
  }>
  budget: BrainBudget
  stateVersion: number
}

export interface SubtaskDraft {
  title: string
  description: string
  requiredCapabilities: string[]
  maxAttempts?: number
}

export interface DelegateRequest {
  subtaskId: string
  objective: string
  agentId?: string
}

export type BrainAction =
  /** 直接回复用户，不建任务（对话模式的主路径）。 */
  | { type: 'reply'; text: string }
  | { type: 'revise_plan'; subtasks: SubtaskDraft[]; reason: string }
  | { type: 'delegate'; request: DelegateRequest }
  | { type: 'cancel'; executionId: string; reason: string }
  | { type: 'accept'; subtaskId: string; rationale: string }
  | { type: 'reject'; subtaskId: string; reason: string; next: 'retry' | 'replan' }
  | {
      type: 'request_human'
      kind?: 'clarify' | 'decide'
      question: string
      options?: string[]
      questionId?: string
      executionId?: string
    }
  | { type: 'finish'; summary: string }

export type DecisionRecordType =
  | 'decompose'
  | 'select_agent'
  | 'replan'
  | 'retry'
  | 'abort'
  | 'merge'
  | 'accept_result'

export interface DecisionRationale {
  type: DecisionRecordType
  rationale: string
  alternatives?: string[]
}

export interface DecisionRecord {
  id: string
  goalId: string
  planRevision?: number
  type: DecisionRecordType
  rationale: string
  inputs: Record<string, unknown>
  alternatives?: string[]
  decidedAt: string
}

export interface Clarification {
  id: string
  goalId: string
  kind: 'clarify' | 'decide'
  executionId?: string
  question: string
  options: string[]
  status: 'pending' | 'answered' | 'expired'
  answer?: string
  answeredBy?: 'human'
  createdAt: string
  expiresAt: string
  answeredAt?: string
}

export interface OrchestratorBrain {
  step(input: BrainInput): Promise<BrainAction[]>
  explain(input: BrainInput): Promise<DecisionRationale[]>
}
