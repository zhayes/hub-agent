import type { AgentCard, AgentSkill } from '@a2a-js/sdk'

export interface AgentCardInput {
  /** 对外展示名；默认 `HubAgent`。 */
  name: string
  description: string
  /** 本机 HubAgent 版本。 */
  version: string
  /** A2A 端点的公开地址（含端口）；必须与监听面一致。 */
  url: string
  /** 是否声明流式能力。关掉时客户端只能轮询 `GetTask`。 */
  streaming: boolean
  /** 允许对端调用的能力；空 = 只接受普通任务委托。 */
  skills?: readonly AgentSkill[]
}

/**
 * 构造对外 Agent Card。
 *
 * 只公开“愿意公开的能力与端点”，不枚举本地 Agent 目录（ADR 0026）。
 * 版本固定声明 1.0 + JSONRPC，且**不声明** 0.3 —— 空版本头会被当作 0.3，
 * 所以服务端必须明确拒绝而不是猜测（PRD §7.6.5）。
 */
export function buildAgentCard(input: AgentCardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    supportedInterfaces: [
      {
        url: input.url,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
    ],
    provider: undefined,
    version: input.version,
    capabilities: {
      streaming: input.streaming,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [...(input.skills ?? [])],
    signatures: [],
  }
}
