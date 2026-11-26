import { HubError } from '../../shared/errors'
import type {
  BrainAction,
  BrainDeltaSink,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
} from '../types'
import { createMetaTools } from './meta-tools'
import { buildBrainSystemPrompt, buildBrainUserPrompt } from './prompt'
import type { PiSessionFactory } from './session'

export interface PiBrainOptions {
  factory: PiSessionFactory
  cwd?: string
  agentDir?: string
}

/**
 * PiBrain：用 Pi 官方 SDK 的模型配置/认证/session 跑 Brain 回合。
 * session 无工具、in-memory；模型只输出 intent，副作用由 Runtime 执行。
 */
export class PiBrain implements OrchestratorBrain {
  private readonly factory: PiSessionFactory
  private readonly cwd: string
  private readonly agentDir: string | undefined
  private cache: { stateVersion: number; actions: BrainAction[] } | undefined

  constructor(options: PiBrainOptions) {
    this.factory = options.factory
    this.cwd = options.cwd ?? process.cwd()
    this.agentDir = options.agentDir
  }

  async step(input: BrainInput, sink?: BrainDeltaSink): Promise<BrainAction[]> {
    const meta = createMetaTools(input)
    const session = await this.factory.create({
      cwd: this.cwd,
      systemPrompt: buildBrainSystemPrompt(input.conversation !== undefined),
      tools: meta.tools,
      ...(this.agentDir === undefined ? {} : { agentDir: this.agentDir }),
    })
    const unsubscribe = sink === undefined ? undefined : session.subscribe?.(sink)
    try {
      try {
        await session.prompt(buildBrainUserPrompt(input))
      } catch (error) {
        throw new HubError('BRAIN_UNAVAILABLE', 'Pi 模型调用失败', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      const actions =
        meta.state.actions.length > 0
          ? meta.state.actions
          : parseActions(session.getLastAssistantText() ?? '')
      this.cache = { stateVersion: input.stateVersion, actions }
      return actions
    } finally {
      unsubscribe?.()
      session.dispose()
    }
  }

  async explain(input: BrainInput): Promise<DecisionRationale[]> {
    if (this.cache === undefined || this.cache.stateVersion !== input.stateVersion) {
      return [{ type: 'accept_result', rationale: 'PiBrain 未提供缓存理由' }]
    }
    return this.cache.actions.map(toRationale)
  }
}

function parseActions(content: string): BrainAction[] {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (text.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 对话模式下模型直接回自然语言是正常输出，不该把整轮判成失败：
       当作 reply 交给用户，比丢一条“不是合法 JSON”的错误有用。 */
    return [{ type: 'reply', text }]
  }
  if (Array.isArray(parsed)) return parsed as BrainAction[]
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'actions' in parsed &&
    Array.isArray((parsed as { actions?: unknown }).actions)
  ) {
    return (parsed as { actions: BrainAction[] }).actions
  }
  if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
    return [parsed as BrainAction]
  }
  throw new HubError('BRAIN_UNAVAILABLE', 'Pi JSON 缺少 actions 数组', {
    preview: text.slice(0, 500),
  })
}

function toRationale(action: BrainAction): DecisionRationale {
  switch (action.type) {
    case 'reply':
      return { type: 'accept_result', rationale: action.text }
    case 'revise_plan':
      return { type: 'decompose', rationale: action.reason }
    case 'delegate':
      return {
        type: 'select_agent',
        rationale: `委派子任务 ${action.request.subtaskId} 给 ${action.request.agentId ?? '自动选择'}`,
      }
    case 'accept':
      return { type: 'accept_result', rationale: action.rationale }
    case 'reject':
      return { type: 'retry', rationale: action.reason }
    case 'cancel':
      return { type: 'abort', rationale: action.reason }
    case 'request_human':
      return { type: 'accept_result', rationale: action.question }
    case 'finish':
      return { type: 'accept_result', rationale: action.summary }
  }
}
