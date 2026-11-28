import type { ChatMessageId, ChatThreadId, GoalId, TaskId, Timestamp } from './ids'
import type { PermissionMode } from './status'

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

/** 交付方式（PRD §6.12.4）。只保留用户能真正拿走的两种。 */
export type DeliveryMode = 'branch-only' | 'patch-export'

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === 'branch-only' || value === 'patch-export'
}

/**
 * 会话级运行设置：控制台接管 CLI 独有能力的载体（ADR 0029 §2.4）。
 *
 * 只放**用户与项目策略**，不放任务语义：审批、验收判定、交付执行仍归 Runtime。
 *
 * 没有预算字段：成本/用量在运行时没有计量源，给一个无法执行的旋钮比没有更糟
 * （ADR 0031）。回合超时与动作上限是内部护栏，不是可配置项。
 *
 * 交付方式是**显式动作**（任务页的「导出补丁」）而不是会话设置：
 * PRD §6.12.4 的第一优先级就是“用户单次显式指定”。
 */
export interface ChatRunSettings {
  /** 验收命令：退出码 0 为通过。空数组 = 只有默认的 diffScope 检查。 */
  verifyCommands: string[]
  /** 允许参与本次运行的 Agent 名称；空数组 = 全部可用 Agent。 */
  agents: string[]
}

export const DEFAULT_RUN_SETTINGS: ChatRunSettings = {
  verifyCommands: [],
  agents: [],
}

const MAX_COMMAND_LENGTH = 500
const MAX_COMMANDS = 8
const MAX_AGENTS = 16

function readCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const commands = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '' && item.length <= MAX_COMMAND_LENGTH)
  return [...new Set(commands)].slice(0, MAX_COMMANDS)
}

function readAgents(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return [...new Set(names)].slice(0, MAX_AGENTS)
}

/**
 * 把任意来源的值规范成运行设置：坏字段退到默认值。
 * HTTP 入参与库里读出来的 JSON 走同一份规则，两边不会一个严格一个宽松。
 */
export function normalizeRunSettings(value: unknown): ChatRunSettings {
  if (value === null || typeof value !== 'object') return DEFAULT_RUN_SETTINGS
  const record = value as Record<string, unknown>
  return {
    verifyCommands: readCommands(record['verifyCommands']),
    agents: readAgents(record['agents']),
  }
}

/**
 * 读库时用：坏值一律退到默认值，不让一段坏 JSON 把会话变不可执行。
 */
export function parseRunSettings(raw: string | null | undefined): ChatRunSettings {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_RUN_SETTINGS
  try {
    return normalizeRunSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_RUN_SETTINGS
  }
}

/** 写库时用：只序列化规范化过的字段。 */
export function serializeRunSettings(settings: ChatRunSettings): string {
  return JSON.stringify(settings)
}

export interface ChatThread {
  id: ChatThreadId
  title: string
  goalId?: GoalId
  taskId?: TaskId
  status: ChatThreadStatus
  /**
   * 本会话的工作区（绝对路径）。缺省表示**不可执行**：不再回落到服务进程 cwd。
   */
  worktree?: string
  /** 会话权限档：决定 Agent 的工具授权怎么答。 */
  permissionMode: PermissionMode
  /** 运行设置：验收命令 / 可用 Agent / 预算 / 交付方式。 */
  runSettings: ChatRunSettings
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
