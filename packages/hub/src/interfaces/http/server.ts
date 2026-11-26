import { existsSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createChatService } from '../../runtime/chat/chat-service'
import { type RecoveryReport, scanRecovery } from '../../runtime/recovery/scan'
import { createLocalAcpExecutor } from '../../runtime/scheduler/local-executor'
import { runSchedulerTick } from '../../runtime/scheduler/tick'
import { createSrtProvider } from '../../sandbox/srt-driver'
import { HubError } from '../../shared/errors'
import { acquireLock } from '../../shared/lock'
import { dbPath, hubDir, lockPath, resolvePiAgentDir, tokenPath } from '../../shared/paths'
import { openDatabase } from '../../storage/db'
import { migrate } from '../../storage/migrate'
import { type A2aServerHandle, startA2aServer } from '../a2a/server'
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
  /** 端口被占用时最多尝试多少个后续端口 */
  portAttempts?: number
  /** 调度器 tick 间隔；0 = 关闭（测试用）。默认 5s。 */
  schedulerIntervalMs?: number
  /**
   * A2A 入站面（ADR 0026）：**默认关闭**，必须显式 `enabled: true` 才监听。
   * 独立端口与独立鉴权，不复用本地 token。
   */
  a2a?: {
    enabled: boolean
    port?: number
    host?: string
    publicUrl?: string
    peers?: Array<{ displayName: string; token: string }>
  }
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
  /** 实际托管的前端目录；排查“页面为什么没更新”时先看这个 */
  webDist: string
  /** index.html 的构建时间（ISO）；未构建时缺省 */
  webBuiltAt?: string
  /** A2A 入站面；未启用时为 undefined。 */
  a2a?: { url: string; port: number; host: string }
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
      server.off('error', onError)
      // 绑定失败的 server 从未 listening；这里不调 close()，否则它可能再抛一个
      // ERR_SERVER_NOT_RUNNING 的 'error'，把整个进程带走（端口被占用时尤其明显）。
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
  /* 以 index.html 为准：目录存在但没有入口时，页面同样 404。 */
  const webIndex = join(webDist, 'index.html')
  const webBuilt = existsSync(webIndex)
  const webBuiltAt = webBuilt ? statSync(webIndex).mtime.toISOString() : undefined
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

  /* A2A 入站面：默认关；显式开启后是**独立监听器 + 独立鉴权**（ADR 0026）。
     开启失败就不启动 daemon——运营者明确要求了它，静默降级比启动失败更危险。 */
  let a2a: A2aServerHandle | undefined
  if (options.a2a?.enabled === true) {
    try {
      a2a = await startA2aServer({
        db,
        provider,
        version: options.version,
        worktree: options.worktree ?? process.cwd(),
        ...(options.a2a.port === undefined ? {} : { port: options.a2a.port }),
        ...(options.a2a.host === undefined ? {} : { host: options.a2a.host }),
        ...(options.a2a.publicUrl === undefined ? {} : { publicUrl: options.a2a.publicUrl }),
        ...(options.a2a.peers === undefined ? {} : { peers: options.a2a.peers }),
      })
    } catch (error) {
      clearInterval(keepAlive)
      await new Promise<void>((resolve) => listening?.server.close(() => resolve()))
      await provider.dispose().catch(() => undefined)
      db.close()
      await lock.release()
      throw new HubError(
        'CONFIG_INVALID',
        `A2A 入站面启动失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /* 常驻调度：回收过期 claim + 消费派发意图（ADR 0027）。
     首轮异步启动，不拖延监听；单次失败只记不抛，不能把 daemon 带下去。
     关闭时要等在途 tick 收尾——否则它可能在 db 关掉之后才回来。 */
  const localExecutor = createLocalAcpExecutor({ db, provider })
  let closing = false
  let inFlight: Promise<void> | undefined
  const tick = async (): Promise<void> => {
    if (closing) return
    try {
      await runSchedulerTick(db, { createExecutor: () => localExecutor })
    } catch {
      // 调度失败留给下一轮重试；持久化状态本身是完整的。
    }
  }
  const intervalMs = options.schedulerIntervalMs ?? 5_000
  const schedulerTimer =
    intervalMs > 0
      ? setInterval(() => {
          if (inFlight !== undefined) return
          inFlight = tick().finally(() => {
            inFlight = undefined
          })
        }, intervalMs)
      : undefined
  schedulerTimer?.unref?.()
  inFlight = tick().finally(() => {
    inFlight = undefined
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    closing = true
    if (schedulerTimer !== undefined) clearInterval(schedulerTimer)
    clearInterval(keepAlive)
    /* 等在途 tick 结束：它可能正在写库，不能让 db 先关。 */
    await inFlight?.catch(() => undefined)
    await a2a?.close().catch(() => undefined)
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
    webDist,
    ...(webBuiltAt === undefined ? {} : { webBuiltAt }),
    ...(a2a === undefined ? {} : { a2a: { url: a2a.url, port: a2a.port, host: a2a.host } }),
    close,
  }
}
