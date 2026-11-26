import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createChatService } from '../../runtime/chat/chat-service'
import { type RecoveryReport, scanRecovery } from '../../runtime/recovery/scan'
import { createSrtProvider } from '../../sandbox/srt-driver'
import { HubError } from '../../shared/errors'
import { acquireLock } from '../../shared/lock'
import { dbPath, hubDir, lockPath, resolvePiAgentDir, tokenPath } from '../../shared/paths'
import { openDatabase } from '../../storage/db'
import { migrate } from '../../storage/migrate'
import { createHttpApp } from './app'
import { ensureHttpToken } from './token'

/**
 * Hub 进程的启动单元：HTTP + SSE + SQLite + 单实例锁 + 沙箱 provider。
 *
 * 放在这一层的理由：它只负责「把服务端起来」，不解析命令行；`ha web` 与
 * `hubagentd` 共用同一份实现，避免两套启动路径长出不同行为。
 */

export interface StartHubOptions {
  version: string
  /** 0 表示由系统分配；默认 7788 */
  port?: number
  /** 覆盖运行目录（测试用）；默认 ~/.hubagent */
  home?: string
  /** 覆盖控制台构建产物目录；默认按包根解析 packages/web/dist */
  webDist?: string
  /** Chat 的工作目录；默认 cwd */
  worktree?: string
  /** 端口被占用时最多尝试多少个连续端口 */
  portAttempts?: number
}

export type HubRecovery = RecoveryReport | { error: string }

export interface HubHandle {
  url: string
  port: number
  home: string
  tokenPath: string
  lockPath: string
  recovery: HubRecovery
  /** 控制台构建产物是否存在；缺失时服务仍能起，只是页面 404 */
  webBuilt: boolean
  close: () => Promise<void>
}

const DEFAULT_PORT = 7788

/** 包内的控制台构建产物：相对本文件解析，不依赖 cwd。 */
export function defaultWebDist(): string {
  return fileURLToPath(new URL('../../../../../packages/web/dist/', import.meta.url))
}

function listenOn(
  app: ReturnType<typeof createHttpApp>,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let server: Server
    try {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }) as unknown as Server
    } catch (error) {
      reject(error)
      return
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      server.close()
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

export async function startHub(options: StartHubOptions): Promise<HubHandle> {
  const home = options.home ?? hubDir()
  const lock = await acquireLock(home, lockPath(home))
  const db = openDatabase(dbPath(home))
  migrate(db)

  let recovery: HubRecovery
  try {
    recovery = scanRecovery(db)
  } catch (error) {
    // 恢复失败不能让整个进程起不来——否则一次异常执行会永久挡住启动。
    recovery = { error: error instanceof Error ? error.message : String(error) }
  }

  const token = ensureHttpToken(home)
  const webDist = options.webDist ?? process.env['HUBAGENT_WEB_DIST'] ?? defaultWebDist()
  const webBuilt = existsSync(webDist)
  const provider = createSrtProvider()
  const chat = createChatService({
    db,
    provider,
    clientVersion: options.version,
    worktree: options.worktree ?? process.cwd(),
  })
  const app = createHttpApp({
    db,
    token: token.token,
    version: options.version,
    webDist,
    chat,
    provider,
    home,
    modelDir: resolvePiAgentDir(),
  })

  const basePort =
    options.port ?? Number.parseInt(process.env['HUBAGENT_PORT'] ?? `${DEFAULT_PORT}`, 10)
  const attempts = options.portAttempts ?? 10
  let listening: { server: Server; port: number } | undefined
  let lastError: unknown
  for (let index = 0; index < attempts; index += 1) {
    try {
      listening = await listenOn(app, basePort + index)
      break
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') break
    }
  }

  if (listening === undefined) {
    db.close()
    await provider.dispose().catch(() => undefined)
    await lock.release()
    throw new HubError(
      'CONFIG_INVALID',
      `无法监听端口 ${basePort}–${basePort + attempts - 1}：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }

  // 显式保活：即使未来 server 不再持有事件循环，进程也不会瞬间退出。
  const keepAlive = setInterval(() => undefined, 60_000)
  keepAlive.unref?.()

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(keepAlive)
    await new Promise<void>((resolve) => listening?.server.close(() => resolve()))
    await provider.dispose().catch(() => undefined)
    db.close()
    await lock.release()
  }

  return {
    url: `http://127.0.0.1:${listening.port}`,
    port: listening.port,
    home,
    tokenPath: tokenPath(home),
    lockPath: lockPath(home),
    recovery,
    webBuilt,
    close,
  }
}
