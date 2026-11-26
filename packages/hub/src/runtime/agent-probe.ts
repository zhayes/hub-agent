import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import { AcpClient } from '../adapters/acp/client'
import { AgentHost } from '../agent-host/agent-host'
import type { SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { AgentRecord } from './agent-registry'

/**
 * 探测 / 登录一个已注册 Agent（ADR 0021）。
 *
 * - 走 AgentHost → SandboxProvider，与任务执行同一等级隔离；
 * - 用临时空目录当 cwd，不碰用户仓库；
 * - 探测只做 initialize（+ session/new 以识别登录要求），不发 prompt；
 * - 结束后杀进程、删临时目录，不写任务记录。
 */

export interface AuthMethod {
  id: string
  name?: string
  description?: string | null
  /** terminal 类型要求客户端起交互式 TUI，HubAgent 不支持 */
  type?: 'agent' | 'terminal'
}

export type ProbeStatus = 'online' | 'needs_auth' | 'error'

export interface ProbeResult {
  ok: boolean
  status: ProbeStatus
  durationMs: number
  authMethods: AuthMethod[]
  stderrTail: string[]
  protocolVersion?: number
  capabilities?: unknown
  error?: { code: string; message: string }
}

export interface ProbeOptions {
  provider: SandboxProvider
  agent: AgentRecord
  /** Hub 运行目录；临时工作区建在它下面 */
  home: string
  initializeTimeoutMs?: number
  sessionTimeoutMs?: number
}

export interface AuthenticateResult {
  ok: boolean
  durationMs: number
  methodId: string
  stderrTail: string[]
  error?: { code: string; message: string }
}

const STDERR_TAIL_LINES = 20
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_TIMEOUT_MS = 30_000

function isAuthRequired(error: unknown): boolean {
  if (!(error instanceof HubError)) return false
  const details = (error.details ?? {}) as Record<string, unknown>
  if (details['rpcCode'] === -32000) return true
  return /authentication required|not authenticated|login required|需要登录/i.test(error.message)
}

function toError(error: unknown): { code: string; message: string } {
  if (error instanceof HubError) return { code: error.code, message: error.message }
  return { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) }
}

function authMethodsOf(initialized: InitializeResponse): AuthMethod[] {
  return (initialized.authMethods ?? []).map((method) => ({
    id: method.id,
    ...(method.name === undefined ? {} : { name: method.name }),
    ...(method.description === undefined ? {} : { description: method.description }),
    type: ('type' in method && method.type === 'terminal' ? 'terminal' : 'agent') as
      | 'agent'
      | 'terminal',
  }))
}

interface Connection {
  client: AcpClient
  initialized: InitializeResponse
  workspace: string
  stderrTail: string[]
  close: () => Promise<void>
}

async function openConnection(
  options: ProbeOptions,
  label: string,
): Promise<
  | { ok: true; connection: Connection }
  | { ok: false; error: { code: string; message: string }; stderrTail: string[] }
> {
  const workspace = join(options.home, 'probe', newId())
  mkdirSync(workspace, { recursive: true })
  const stderrTail: string[] = []
  const host = new AgentHost({ provider: options.provider })
  const processId = `${label}-${newId()}`

  const cleanup = async (client?: AcpClient): Promise<void> => {
    await client?.dispose().catch(() => undefined)
    await host.kill(processId).catch(() => undefined)
    await host.dispose().catch(() => undefined)
    rmSync(workspace, { recursive: true, force: true })
  }

  let client: AcpClient | undefined
  try {
    const agentProcess = await host.spawn(processId, {
      worktree: workspace,
      command: options.agent.command,
      sandbox: {
        allowedWrite: [...options.agent.allowedWrite, workspace],
        networkMode: options.agent.networkMode,
        ...(options.agent.allowedDomains.length === 0
          ? {}
          : { allowedDomains: options.agent.allowedDomains }),
      },
    })

    client = new AcpClient({
      process: agentProcess,
      version: label,
      initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      requestTimeoutMs: options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      onStderr: (line) => {
        stderrTail.push(line)
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      },
    })

    const initialized = await client.start()
    return {
      ok: true,
      connection: {
        client,
        initialized,
        workspace,
        stderrTail,
        close: async () => cleanup(client),
      },
    }
  } catch (error) {
    await cleanup(client)
    return { ok: false, error: toError(error), stderrTail }
  }
}

export async function probeAgent(options: ProbeOptions): Promise<ProbeResult> {
  const startedAt = Date.now()
  const opened = await openConnection(options, 'probe')
  if (!opened.ok) {
    return {
      ok: false,
      status: 'error',
      durationMs: Date.now() - startedAt,
      authMethods: [],
      stderrTail: opened.stderrTail,
      error: opened.error,
    }
  }

  const { client, initialized, workspace, stderrTail, close } = opened.connection
  const authMethods = authMethodsOf(initialized)
  const base = {
    durationMs: 0,
    authMethods,
    stderrTail,
    ...(initialized.protocolVersion === undefined
      ? {}
      : { protocolVersion: initialized.protocolVersion }),
    ...(initialized.agentCapabilities === undefined
      ? {}
      : { capabilities: initialized.agentCapabilities }),
  }

  try {
    try {
      await client.newSession(workspace)
    } catch (error) {
      // Agent 已经声明了登录方式，却建不了会话：这是「需要登录/配凭据」，不是协议失败。
      if (authMethods.length > 0 || isAuthRequired(error)) {
        return {
          ...base,
          ok: false,
          status: 'needs_auth',
          durationMs: Date.now() - startedAt,
          error: {
            code: 'ADAPTER_INCOMPATIBLE',
            message: `需要登录后才能建立会话：${
              error instanceof HubError ? error.message : String(error)
            }`,
          },
        }
      }
      return {
        ...base,
        ok: false,
        status: 'error',
        durationMs: Date.now() - startedAt,
        error: toError(error),
      }
    }
    return { ...base, ok: true, status: 'online', durationMs: Date.now() - startedAt }
  } finally {
    await close()
  }
}

export async function authenticateAgent(
  options: ProbeOptions & { methodId: string },
): Promise<AuthenticateResult> {
  const startedAt = Date.now()
  const opened = await openConnection(options, 'auth')
  if (!opened.ok) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      methodId: options.methodId,
      stderrTail: opened.stderrTail,
      error: opened.error,
    }
  }

  const { client, initialized, stderrTail, close } = opened.connection
  try {
    const methods = authMethodsOf(initialized)
    const method = methods.find((item) => item.id === options.methodId)
    if (method === undefined) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        methodId: options.methodId,
        stderrTail,
        error: { code: 'CONFIG_INVALID', message: `Agent 没有声明登录方式 ${options.methodId}` },
      }
    }
    if (method.type === 'terminal') {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        methodId: options.methodId,
        stderrTail,
        error: {
          code: 'ACTION_REJECTED',
          message: '该方法要求交互式终端，HubAgent 不支持；请选择浏览器/设备码登录方式',
        },
      }
    }
    await client.authenticate(options.methodId)
    return { ok: true, durationMs: Date.now() - startedAt, methodId: options.methodId, stderrTail }
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      methodId: options.methodId,
      stderrTail,
      error: toError(error),
    }
  } finally {
    await close()
  }
}
