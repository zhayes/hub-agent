import { HubError } from '../../shared/errors'

export interface LlmCompletionRequest {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
}

export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<string>
}

export interface OpenAiCompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 部分 provider 不支持 response_format；默认 true（DeepSeek/OpenAI 兼容） */
  jsonMode?: boolean
}

/**
 * 最小 OpenAI-compatible chat client。只依赖 fetch，不引入 SDK。
 * Brain 层不碰数据库/子进程；这里只做一次有超时的模型调用。
 */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly endpoint: string
  private readonly config: OpenAiCompatibleConfig

  constructor(config: OpenAiCompatibleConfig) {
    this.config = config
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          temperature: 0,
          max_tokens: request.maxTokens,
          ...(this.config.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      })
    } catch (error) {
      throw new HubError('BRAIN_UNAVAILABLE', 'Brain 模型请求失败', {
        endpoint: this.endpoint,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new HubError('BRAIN_UNAVAILABLE', `Brain 模型返回 HTTP ${response.status}`, {
        endpoint: this.endpoint,
        status: response.status,
        body: body.slice(0, 1000),
      })
    }

    const payload = (await response.json().catch(() => undefined)) as
      | { choices?: Array<{ message?: { content?: unknown } }> }
      | undefined
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new HubError('BRAIN_UNAVAILABLE', 'Brain 模型返回空内容', {
        endpoint: this.endpoint,
      })
    }
    return content
  }
}
