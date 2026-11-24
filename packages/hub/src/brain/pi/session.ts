import { HubError } from '../../shared/errors'

export interface PiSession {
  prompt(text: string): Promise<void>
  getLastAssistantText(): string | undefined
  dispose(): void
}

export interface CreatePiSessionInput {
  cwd: string
  systemPrompt: string
  agentDir?: string
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
        const { session } = await sdk.createAgentSession({
          cwd: input.cwd,
          agentDir,
          sessionManager: sdk.SessionManager.inMemory(),
          resourceLoader: loader,
          noTools: 'all',
          tools: [],
        })
        return {
          prompt: (text) => session.prompt(text),
          getLastAssistantText: () => session.getLastAssistantText(),
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
