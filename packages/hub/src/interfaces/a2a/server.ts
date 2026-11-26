import type { Server } from 'node:http'
import type { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler } from '@a2a-js/sdk/server'
import { serve } from '@hono/node-server'
import { buildAgentCard } from '../../adapters/a2a/card'
import { createSqliteTaskStore } from '../../adapters/a2a/task-store'
import type { VerificationCheck } from '../../domain/entities'
import { createA2aExecutor, type InboundTaskRunner } from '../../runtime/a2a-executor'
import { bearerOf, ensurePeer, verifyPeerToken } from '../../runtime/a2a-peers'
import { createInboundTaskRunner } from '../../runtime/a2a-runner'
import type { SandboxProvider } from '../../sandbox/types'
import type { Db } from '../../storage/db'
import { createA2aApp } from './routes'

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
  peers?: Array<{ displayName: string; token: string }>
  checks?: readonly VerificationCheck[]
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

  for (const peer of options.peers ?? []) {
    ensurePeer(options.db, peer)
  }

  /* 端口为 0 时监听前拿不到真实端口，所以先建卡、监听后再回填 URL。 */
  const card: AgentCard = buildAgentCard({
    name: 'HubAgent',
    description: '本地优先的多 Agent 编排器（A2A 入站面）',
    version: options.version,
    url: options.publicUrl ?? `http://${host}:${port}/a2a`,
    streaming: true,
  })

  const runner: InboundTaskRunner = createInboundTaskRunner({
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
    verify: (authorization) => {
      const token = bearerOf(authorization)
      return token === undefined ? undefined : verifyPeerToken(options.db, token)
    },
  })

  const listening = await listen(app, host, port)
  const url = `${options.publicUrl ?? `http://${host}:${listening.port}/a2a`}`

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
  app: ReturnType<typeof createA2aApp>,
  host: string,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let server: Server
    try {
      server = serve({ fetch: app.fetch, hostname: host, port }) as unknown as Server
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
