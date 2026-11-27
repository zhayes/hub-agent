import type { AgentCard, Task, TaskState } from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client'
import { createMutualTlsFetch, type MutualTlsMaterial } from './mtls'

export interface RemoteAgentOptions {
  /** 对端地址（origin 或已带路径均可；`createFromUrl` 会去取 well-known 卡片）。 */
  url: string
  /** Peer token；只放在 Authorization 头里。mTLS 模式下可省略（服务端不看它）。 */
  token?: string
  /** 测试可注入的 fetch；默认全局 fetch。传了 `tls` 时忽略。 */
  fetchImpl?: typeof fetch
  /**
   * 出站 mTLS 材料（客户端证书）。给了就用基于 `node:https` 的 fetch，
   * 而不是全局 fetch——全局 fetch 无法携带客户端证书（除非引入 undici）。
   */
  tls?: MutualTlsMaterial
}

export interface RemoteSendResult {
  taskId: string
  contextId: string
  /** 发送后的即时状态（非阻塞模式下通常不是终态）。 */
  state: TaskState
}

export interface RemoteAgentClient {
  card(): Promise<AgentCard>
  /** 非阻塞发送：只拿到 taskId 与当前状态，之后用 `get` 轮询。 */
  send(input: { text: string; messageId?: string }): Promise<RemoteSendResult>
  get(taskId: string): Promise<Task>
  cancel(taskId: string): Promise<Task>
}

/**
 * 出站 A2A 客户端（A3）。
 *
 * 三件事刻意这样做：
 * 1. **非阻塞发送**（`polling: true`）：`SendMessage` 立即返回，等待与对账由调用方
 *    的调度器负责——与 ADR 0027 的“回合不阻塞”一致。
 * 2. **每次请求带 Peer token**：通过注入 fetch 加 `Authorization`，不全局改环境。
 * 3. **协议版本由 SDK 负责**：它按卡片里匹配的 `AgentInterface.protocolVersion`
 *    自动发 `A2A-Version`，我们不再手写（手写反而可能与卡片不一致）。
 */
export async function connectRemoteAgent(options: RemoteAgentOptions): Promise<RemoteAgentClient> {
  /* mTLS 优先：需要客户端证书时必须用 https fetch，全局 fetch 带不了证书。 */
  const baseFetch: typeof fetch =
    options.tls !== undefined ? createMutualTlsFetch(options.tls) : (options.fetchImpl ?? fetch)
  const token = options.token
  const authedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    /* mTLS 模式下服务端不看 token；不传就不发，避免无意义地把凭据送上线路。 */
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
    return baseFetch(input, { ...init, headers })
  }

  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authedFetch })],
    clientConfig: { polling: true },
    /* 卡片拉取走的是 resolver 自己的 fetch，必须显式传，否则会落到全局 fetch
       （mTLS 场景下就连不上了：全局 fetch 带不了客户端证书）。 */
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authedFetch }),
  })
  const client = await factory.createFromUrl(options.url)

  return {
    card: () => client.getAgentCard(),
    async send({ text, messageId }) {
      const result = await client.sendMessage({
        tenant: '',
        message: {
          messageId: messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: 1 /* ROLE_USER */,
          contextId: '',
          taskId: '',
          parts: [
            {
              content: { $case: 'text', value: text },
              metadata: undefined,
              filename: '',
              mediaType: 'text/plain',
            },
          ],
          extensions: [],
          referenceTaskIds: [],
          metadata: {},
        },
        configuration: undefined,
        metadata: {},
      })

      /* SDK 可能直接回 Message（对端选择不建 Task）：那种情况我们没有 taskId 可对账。 */
      const task = isTask(result) ? result : undefined
      if (task === undefined) {
        throw new Error('对端没有创建 Task（返回了纯 Message），无法按任务对账')
      }
      return {
        taskId: task.id,
        contextId: task.contextId,
        state: task.status?.state ?? 0,
      }
    },
    get: (taskId) => client.getTask({ tenant: '', id: taskId, historyLength: 0 }),
    cancel: (taskId) => client.cancelTask({ tenant: '', id: taskId, metadata: {} }),
  }
}

/** `SendMessageResult` 是 `Message | Task`：Task 有 status，Message 没有。 */
function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && 'status' in value
}
