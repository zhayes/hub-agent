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
  createdAt: Timestamp
}
