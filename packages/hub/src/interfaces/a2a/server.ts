import type { Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler } from '@a2a-js/sdk/server'
import { serve } from '@hono/node-server'
import { buildAgentCard } from '../../adapters/a2a/card'
import { createSqliteTaskStore } from '../../adapters/a2a/task-store'
import type { VerificationCheck } from '../../domain/entities'
import { createA2aExecutor, type InboundTaskRunner } from '../../runtime/a2a-executor'
import {
  bearerOf,
  ensurePeer,
  verifyPeerCertificate,
  verifyPeerToken,
} from '../../runtime/a2a-peers'
import { createInboundTaskRunner } from '../../runtime/a2a-runner'
import type { SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import type { Db } from '../../storage/db'
import { createA2aApp } from './routes'

/**
 * A2A 监听面的 TLS 配置（ADR 0026 变更节：Relay 之前必须能上 mTLS）。
 *
 * - 只给 `key`/`cert`：服务端单向上 TLS（对端不验证，仍需 token 认证）；
 * - 加 `ca` + `requireClientCert: true`：双向 TLS，身份来自客户端证书。
 */
export interface A2aTlsOptions {
  key: string | Buffer
  cert: string | Buffer
  /** 受信 CA；`requireClientCert` 时**必填**（没有它无法校验证书链）。 */
  ca?: string | Buffer | ReadonlyArray<string | Buffer>
  /** true = 要求并校验客户端证书（mTLS）；此时 token 不再作为身份来源。 */
  requireClientCert?: boolean
}

export interface A2aServerOptions {
  db: Db
  provider: SandboxProvider
  version: string
  worktree: string
  /** 默认 127.0.0.1。绑定非回环必须显式传，且应由 ADR 0026 的启用流程确认。 */
  host?: string
  /** 0 = 系统分配；默认 7789。 */
  port?: number
  /** 对外公开地址（写入 Agent Card）；缺省按 host/port 拼。 */
  publicUrl?: string
  /** 启动时幂等注册的 Peer（配置驱动，便于首次配对）。 */
  peers?: Array<{ displayName: string; token: string; certFingerprint?: string }>
  /**
   * TLS 配置。非回环监听**必须**提供，否则拒绝启动（ADR 0026）。
   * 需要 mTLS 时同时给 `ca` 与 `requireClientCert: true`。
   */
  tls?: A2aTlsOptions
  checks?: readonly VerificationCheck[]
  /** 覆盖入站执行器（嵌入或测试用）；缺省用 `createInboundTaskRunner`。 */
  runner?: InboundTaskRunner
}

export interface A2aServerHandle {
  url: string
  port: number
  host: string
  close: () => Promise<void>
}

const DEFAULT_A2A_PORT = 7789

/**
 * A2A 入站服务（独立端口，默认回环）。
 *
 * 与本地 HTTP 面的关系（ADR 0026）：**两套鉴权、两个监听器**。
 * 这里不接受本机 token，只用 `a2a_peers` 里的 Peer token。
 */
export async function startA2aServer(options: A2aServerOptions): Promise<A2aServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_A2A_PORT

  /* 硬约束：非回环监听必须 TLS（ADR 0026）。宁可起不来，也不要明文暴露。 */
  if (!isLoopbackHost(host) && options.tls === undefined) {
    throw new HubError(
      'CONFIG_INVALID',
      `A2A 监听 ${host} 属于非回环地址，必须配置 tls（ADR 0026）`,
      { host },
    )
  }
  const requireCertificate = options.tls?.requireClientCert === true
  if (requireCertificate && options.tls?.ca === undefined) {
    throw new HubError('CONFIG_INVALID', 'requireClientCert 必须同时提供 ca，否则无法校验证书链')
  }

  for (const peer of options.peers ?? []) {
    ensurePeer(options.db, peer)
  }

  /* 端口为 0 时监听前拿不到真实端口，所以先建卡、监听后再回填 URL。 */
  const scheme = options.tls === undefined ? 'http' : 'https'
  const card: AgentCard = buildAgentCard({
    name: 'HubAgent',
    description: '本地优先的多 Agent 编排器（A2A 入站面）',
    version: options.version,
    url: options.publicUrl ?? `${scheme}://${host}:${port}/a2a`,
    streaming: true,
  })

  const runner: InboundTaskRunner =
    options.runner ??
    createInboundTaskRunner({
      db: options.db,
      provider: options.provider,
      worktree: options.worktree,
      ...(options.checks === undefined ? {} : { checks: options.checks }),
    })

  const handler = new DefaultRequestHandler(
    card,
    createSqliteTaskStore(options.db),
    createA2aExecutor(runner),
  )
  const app = createA2aApp({
    handler,
    agentCard: card,
    requireCertificate,
    identify: ({ authorization, certificateFingerprint }) => {
      /* mTLS 模式：只认客户端证书，绝不回退到 token（防降级）。 */
      if (requireCertificate) {
        return certificateFingerprint === undefined
          ? undefined
          : verifyPeerCertificate(options.db, certificateFingerprint)
      }
      /* token 模式（A2 现状）：mTLS 关闭时才看 Authorization。 */
      const token = bearerOf(authorization)
      return token === undefined ? undefined : verifyPeerToken(options.db, token)
    },
  })

  const listening = await listen(app.fetch, host, port, options.tls)
  const url = `${options.publicUrl ?? `${scheme}://${host}:${listening.port}/a2a`}`

  /* 回填真实端口：卡和 handler 引用的是同一个对象。 */
  if (card.supportedInterfaces[0] !== undefined) {
    card.supportedInterfaces[0].url = url
  }

  return {
    url,
    port: listening.port,
    host,
    close: async () => {
      await new Promise<void>((resolve) => listening.server.close(() => resolve()))
    },
  }
}

function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  host: string,
  port: number,
  tls: A2aTlsOptions | undefined,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let server: Server
    try {
      /* 关键：https 必须显式传 createServer，否则 @hono/node-server 会用
         http.createServer 忽略 key/cert，变成明文监听。 */
      server = serve({
        fetch,
        hostname: host,
        port,
        ...(tls === undefined
          ? {}
          : {
              createServer: createHttpsServer,
              serverOptions: {
                key: tls.key,
                cert: tls.cert,
                ...(tls.ca === undefined
                  ? {}
                  : { ca: tls.ca as string | Buffer | string[] | Buffer[] }),
                ...(tls.requireClientCert === true
                  ? { requestCert: true, rejectUnauthorized: true }
                  : {}),
              },
            }),
      }) as unknown as Server
    } catch (error) {
      reject(error)
      return
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      const actual = typeof address === 'object' && address !== null ? address.port : port
      resolve({ server, port: actual })
    }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

/**
 * 是否回环地址。
 *
 * 只认 `localhost` / `::1` / `127.0.0.0/8`；`0.0.0.0` 与 `::` 是通配监听，**不算**回环——
 * 它们会暴露到外部网络，因此必须 TLS（ADR 0026）。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  if (normalized === 'localhost' || normalized === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}
