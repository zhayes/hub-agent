import { HubError } from '../../shared/errors'
import type { BrainAction, BrainInput, DecisionRationale, OrchestratorBrain } from '../types'
import type { LlmClient } from './llm-client'
import { buildBrainSystemPrompt, buildBrainUserPrompt } from './prompt'

export interface LlmBrainOptions {
  client: LlmClient
  maxTokens?: number
  timeoutMs?: number
}

/**
 * 真实 LLM Brain。step() 只做一次模型调用；explain() 复用同一 snapshot 的动作缓存，
 * 不额外烧一次 token。输出最终仍由 runtime/validate.ts 做 schema/权限/预算/幂等校验。
 */
export class LlmBrain implements OrchestratorBrain {
  private readonly client: LlmClient
  private readonly maxTokens: number
  private readonly timeoutMs: number
  private cache: { stateVersion: number; actions: BrainAction[] } | undefined

  constructor(options: LlmBrainOptions) {
    this.client = options.client
    this.maxTokens = options.maxTokens ?? 4096
    this.timeoutMs = options.timeoutMs ?? 90_000
  }

  async step(input: BrainInput): Promise<BrainAction[]> {
    const content = await this.client.complete({
      system: buildBrainSystemPrompt(),
      user: buildBrainUserPrompt(input),
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
    })
    const actions = parseActions(content)
    this.cache = { stateVersion: input.stateVersion, actions }
    return actions
  }

  async explain(input: BrainInput): Promise<DecisionRationale[]> {
    if (this.cache === undefined || this.cache.stateVersion !== input.stateVersion) {
      return [{ type: 'accept_result', rationale: 'LLM Brain 未提供缓存理由' }]
    }
    return this.cache.actions.map(toRationale)
  }
}

function parseActions(content: string): BrainAction[] {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new HubError('BRAIN_UNAVAILABLE', 'Brain 返回的不是合法 JSON', {
      reason: error instanceof Error ? error.message : String(error),
      preview: text.slice(0, 500),
    })
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
  throw new HubError('BRAIN_UNAVAILABLE', 'Brain JSON 缺少 actions 数组', {
    preview: text.slice(0, 500),
  })
}

function toRationale(action: BrainAction): DecisionRationale {
  switch (action.type) {
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
