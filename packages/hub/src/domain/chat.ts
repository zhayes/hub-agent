import type { ChatMessageId, ChatThreadId, GoalId, TaskId, Timestamp } from './ids'

/** idle = 已创建但还没有回合；不能当成“运行中”，否则空对话会一直转圈。 */
export type ChatThreadStatus = 'idle' | 'active' | 'waiting' | 'completed' | 'failed'
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
  /** 归档时间；归档后不出现在侧栏，但历史消息仍保留。 */
  archivedAt?: Timestamp
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
  /** progress 步骤的类型：thinking / tool / thought / output / plan ... */
  stage?: ChatProgressStage
  /** 工具调用的结构化明细（JSON：command/output/kind），供前端展开。 */
  detail?: string
  updatedAt?: Timestamp
  createdAt: Timestamp
}

export type ChatProgressStage =
  | 'thinking'
  | 'planned'
  | 'dispatching'
  | 'retrying'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'tool'
  | 'thought'
  | 'output'
