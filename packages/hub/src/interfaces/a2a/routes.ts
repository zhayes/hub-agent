import type { AgentCard } from '@a2a-js/sdk'
import {
  type A2ARequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
} from '@a2a-js/sdk/server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { fingerprintOfCertificate } from '../../adapters/a2a/fingerprint'

export interface A2aIdentity {
  /** `Authorization` 头原文（token 模式用）。 */
  authorization?: string
  /** 当前 TLS 连接上的客户端证书指纹（DER 的 sha256 hex）；非 mTLS 连接为 undefined。 */
  certificateFingerprint?: string
}

export interface A2aAppOptions {
  handler: A2ARequestHandler
  /** 对外卡片；路由层用它做版本校验（transport 自己不校验）。 */
  agentCard: AgentCard
  /** 从连接身份解析 peerId；返回 undefined 表示拒绝（401，零副作用）。 */
  identify: (identity: A2aIdentity) => string | undefined
  /**
   * 是否启用 mTLS 身份。true 时只认客户端证书，**不接受** token 降级
   * （否则攻击者可用 token 绕过“必须持有证书”的要求）。
   */
  requireCertificate?: boolean
}

/** @hono/node-server 把 node 的 req/res 作为 env 传进来，这里只声明用到的那部分。 */
interface A2aEnv {
  Bindings: { incoming?: unknown }
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
export function createA2aApp(options: A2aAppOptions): Hono<A2aEnv> {
  const transport = new JsonRpcTransportHandler(options.handler)
  const app = new Hono<A2aEnv>()

  app.get('/.well-known/agent-card.json', async (c) => {
    const card: AgentCard = await options.handler.getAgentCard()
    return c.json(card)
  })

  app.post('/a2a', async (c) => {
    const certificateFingerprint = clientCertificateFingerprint(incomingOf(c.env))
    /* mTLS 模式下没有证书直接拒绝，不回退到 token。 */
    const identity: A2aIdentity = {
      ...(certificateFingerprint === undefined ? {} : { certificateFingerprint }),
      ...(options.requireCertificate === true
        ? {}
        : authorizationOf(c.req.header('authorization'))),
    }
    const peerId = options.identify(identity)
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

function authorizationOf(value: string | undefined): { authorization?: string } {
  return value === undefined ? {} : { authorization: value }
}

/**
 * 取 node 的 `IncomingMessage`。
 *
 * 经 `@hono/node-server` 时在 `c.env.incoming`；用 Hono 的 `app.request()`（单元测试）
 * 直接调用时 `c.env` 可能是 undefined，所以要防御——没有连接就按非 TLS 处理。
 */
function incomingOf(env: unknown): unknown {
  return (env as { incoming?: unknown } | undefined)?.incoming
}

/**
 * 从 TLS socket 上取客户端证书并算指纹。
 *
 * - 非 TLS（`encrypted !== true`）→ undefined，交给上层按 token 模式判定；
 * - TLS 但无客户端证书 → undefined（`requestCert` 已确保 mTLS 模式下不存在这种连接）；
 * - 证书链校验由 Node 在握手阶段完成（`rejectUnauthorized`），这里只做身份映射。
 */
function clientCertificateFingerprint(incoming: unknown): string | undefined {
  const socket = (incoming as { socket?: unknown } | undefined)?.socket as
    | {
        encrypted?: boolean
        getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer } | null | undefined
      }
    | undefined
  if (socket === undefined || socket.encrypted !== true) return undefined
  const certificate = socket.getPeerCertificate?.(true)
  const raw = certificate?.raw
  if (raw === undefined || raw.length === 0) return undefined
  return fingerprintOfCertificate(raw)
}
