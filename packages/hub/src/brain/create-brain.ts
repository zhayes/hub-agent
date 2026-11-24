import { HubError } from '../shared/errors'
import { LlmBrain } from './pi/llm-brain'
import { OpenAiCompatibleClient } from './pi/llm-client'
import { ScriptedBrain } from './scripted-brain'
import type { OrchestratorBrain } from './types'

export interface BrainEnv {
  HUBAGENT_BRAIN_MODE?: string
  HUBAGENT_BRAIN_API_KEY?: string
  HUBAGENT_BRAIN_BASE_URL?: string
  HUBAGENT_BRAIN_MODEL?: string
  HUBAGENT_BRAIN_TIMEOUT_MS?: string
  HUBAGENT_BRAIN_MAX_TOKENS?: string
}

/**
 * 默认真实 LLM（HUBAGENT_BRAIN_MODE 缺省 = llm）；无 key 时 fail-closed。
 * ScriptedBrain 只在显式 HUBAGENT_BRAIN_MODE=scripted 时用于测试/离线/降级。
 */
export function createBrainFromEnv(env: BrainEnv = process.env): OrchestratorBrain {
  const explicit = env.HUBAGENT_BRAIN_MODE?.trim().toLowerCase()
  const mode = explicit === undefined || explicit === '' ? 'llm' : explicit
  if (mode === 'scripted') return new ScriptedBrain()
  if (mode !== 'llm' && mode !== 'pi') {
    throw new HubError('CONFIG_INVALID', `HUBAGENT_BRAIN_MODE 只能是 llm | pi | scripted：${mode}`)
  }
  const apiKey = env.HUBAGENT_BRAIN_API_KEY?.trim()
  if (apiKey === undefined || apiKey.length === 0) {
    throw new HubError(
      'CONFIG_INVALID',
      '未配置真实 Brain。请设置 HUBAGENT_BRAIN_API_KEY（以及可选的 HUBAGENT_BRAIN_MODEL / BASE_URL）；离线或测试请显式设置 HUBAGENT_BRAIN_MODE=scripted。',
    )
  }
  const baseUrl = env.HUBAGENT_BRAIN_BASE_URL?.trim() || 'https://api.deepseek.com'
  const model = env.HUBAGENT_BRAIN_MODEL?.trim() || 'deepseek-chat'
  const timeoutMs = positiveInt(env.HUBAGENT_BRAIN_TIMEOUT_MS, 90_000)
  const maxTokens = positiveInt(env.HUBAGENT_BRAIN_MAX_TOKENS, 4096)
  return new LlmBrain({
    client: new OpenAiCompatibleClient({ baseUrl, apiKey, model }),
    timeoutMs,
    maxTokens,
  })
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
