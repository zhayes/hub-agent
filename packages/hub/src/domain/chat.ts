import type { ChatMessageId, ChatThreadId, GoalId, TaskId, Timestamp } from './ids'

export type ChatThreadStatus = 'active' | 'waiting' | 'completed' | 'failed'
export type ChatRole = 'user' | 'assistant' | 'system'
export type ChatMessageKind =
  | 'text'
  | 'plan'
  | 'task'
  | 'result'
  | 'error'
  | 'approval'
  | 'clarification'
  /** Runtime 上报的执行步骤（计划/派单/重试/验收），只做过程展示，不进模型上下文。 */
  | 'progress'
  /** Agent 需要授权：卡片里带 agentName，可直接触发 authenticate。 */
  | 'auth'

export interface ChatThread {
  id: ChatThreadId
  title: string
  goalId?: GoalId
  taskId?: TaskId
  status: ChatThreadStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ChatMessage {
  id: ChatMessageId
  threadId: ChatThreadId
  role: ChatRole
  kind: ChatMessageKind
  content: string
  goalId?: GoalId
  taskId?: TaskId
  approvalId?: string
  clarificationId?: string
  /** 'auth' 卡片与 'progress' 步骤关联的 Agent。 */
  agentName?: string
  createdAt: Timestamp
}
