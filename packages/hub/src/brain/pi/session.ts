import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { HubError } from '../../shared/errors'

export interface PiSession {
  prompt(text: string): Promise<void>
  getLastAssistantText(): string | undefined
  /** 订阅 assistant 的 text/thinking 增量；返回取消函数。 */
  subscribe?(listener: (delta: { kind: 'text' | 'thinking'; text: string }) => void): () => void
  dispose(): void
}

export interface CreatePiSessionInput {
  cwd: string
  systemPrompt: string
  agentDir?: string
  tools?: ToolDefinition<TSchema, unknown>[]
}

export interface PiSessionFactory {
  create(input: CreatePiSessionInput): Promise<PiSession>
}

/**
 * 生产实现：用 Pi 官方 TypeScript SDK 创建无工具的 in-memory session。
 * 动态 import 让单测/CLI 未配置 Pi 时不必加载整套 SDK。
 */
export function createPiSessionFactory(options: { agentDir?: string } = {}): PiSessionFactory {
  return {
    async create(input) {
      let sdk: typeof import('@earendil-works/pi-coding-agent')
      try {
        sdk = await import('@earendil-works/pi-coding-agent')
      } catch (error) {
        throw new HubError('BRAIN_UNAVAILABLE', '无法加载 Pi SDK', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      const agentDir = input.agentDir ?? options.agentDir ?? sdk.getAgentDir()
      const loader = new sdk.DefaultResourceLoader({
        cwd: input.cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: input.systemPrompt,
        appendSystemPrompt: [],
        appendSystemPromptOverride: () => [],
      })
      try {
        await loader.reload()
        const customTools = input.tools ?? []
        const { session } = await sdk.createAgentSession({
          cwd: input.cwd,
          agentDir,
          sessionManager: sdk.SessionManager.inMemory(),
          resourceLoader: loader,
          customTools,
          tools: customTools.map((tool) => tool.name),
        })
        return {
          prompt: (text) => session.prompt(text),
          getLastAssistantText: () => session.getLastAssistantText(),
          subscribe: (listener) =>
            session.subscribe((event) => {
              if (event.type !== 'message_update') return
              const delta = event.assistantMessageEvent
              if (delta.type === 'text_delta') listener({ kind: 'text', text: delta.delta })
              else if (delta.type === 'thinking_delta') {
                listener({ kind: 'thinking', text: delta.delta })
              }
            }),
          dispose: () => session.dispose(),
        }
      } catch (error) {
        throw new HubError('BRAIN_UNAVAILABLE', 'Pi session 启动失败', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
