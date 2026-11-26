import type { AgentCard } from '@a2a-js/sdk'
import {
  type A2ARequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
} from '@a2a-js/sdk/server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

export interface A2aAppOptions {
  handler: A2ARequestHandler
  /** 对外卡片；路由层用它做版本校验（transport 自己不校验）。 */
  agentCard: AgentCard
  /** 从 `Authorization` 头解析 peerId；返回 undefined 表示拒绝。 */
  verify: (authorization: string | undefined) => string | undefined
}

/** 规范：缺省版本头按 0.3 处理，而 0.3 未在本卡声明。 */
const DEFAULT_REQUESTED_VERSION = '0.3'

/**
 * A2A 入站 HTTP 面（JSON-RPC + SSE）。
 *
 * 边界（ADR 0026 / PRD §7.6.2）：
 * - **先鉴权再解析业务**：未通过 Peer 校验的请求不会进入 handler，因此不可能创建任务（零副作用）。
 * - 版本头原样传给 `ServerCallContext`；缺省由 SDK 当作 0.3 并拒绝——这是规范行为，不在这里私活。
 * - 只挂 A2A 端口，不复用本地 token，也不与 `interfaces/http` 混在一起。
 */
export function createA2aApp(options: A2aAppOptions): Hono {
  const transport = new JsonRpcTransportHandler(options.handler)
  const app = new Hono()

  app.get('/.well-known/agent-card.json', async (c) => {
    const card: AgentCard = await options.handler.getAgentCard()
    return c.json(card)
  })

  app.post('/a2a', async (c) => {
    const peerId = options.verify(c.req.header('authorization'))
    if (peerId === undefined) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'unauthorized' } },
        401,
      )
    }

    const user = {
      get isAuthenticated(): boolean {
        return true
      },
      get userName(): string {
        return peerId
      },
    }
    const requestedVersion = c.req.header('a2a-version') ?? DEFAULT_REQUESTED_VERSION
    const context = new ServerCallContext({ user, requestedVersion })

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
        400,
      )
    }

    /* transport 不校验版本（实测 0.3/2.0 都会放过），这里必须自己拦。 */
    try {
      validateVersion(requestedVersion, options.agentCard, 'JSONRPC')
    } catch (error) {
      const id =
        typeof body === 'object' && body !== null && 'id' in body
          ? ((body as { id?: string | number | null }).id ?? null)
          : null
      return c.json({
        jsonrpc: '2.0',
        id,
        error: JsonRpcTransportHandler.mapToJSONRPCError(error),
      })
    }

    const result = await transport.handle(body as Record<string, unknown>, context)

    /* 流式方法返回 AsyncGenerator：逐条以 SSE 推出去。 */
    const streaming = result as { [Symbol.asyncIterator]?: unknown }
    if (typeof streaming[Symbol.asyncIterator] === 'function') {
      return streamSSE(c, async (stream) => {
        for await (const item of streaming as AsyncGenerator<unknown>) {
          await stream.writeSSE({ data: JSON.stringify(item) })
        }
      })
    }

    return c.json(result as Record<string, unknown>)
  })

  return app
}
