import {
  type AgentCapabilities,
  type ClientConnection,
  client as createClientApp,
  type InitializeResponse,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
} from '@agentclientprotocol/sdk'
import type { AgentExit, AgentProcess } from '../../agent-host/types'
import { HubError } from '../../shared/errors'
import { type AcpExecutionEvent, mapSessionUpdate, permissionEvent } from './event'
import { type AcpTransport, createAcpTransport } from './transport'

/**
 * ACP v1 客户端。
 *
 * 边界：
 *   - 只调用基线方法 initialize / session/new / session/prompt / session/cancel；
 *     session/close 仅在协商声明支持时调用。
 *   - 不向 Agent 暴露客户端文件系统/终端能力（不把沙箱外的读写递给 Agent）。
 *   - 权限请求默认拒绝；需要放行时由调用方显式提供 handler。
 *   - 所有协议超时/解析失败归因 ADAPTER_INCOMPATIBLE，不污染 Agent 可靠性统计。
 */

export type AcpPermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse

export interface AcpClientOptions {
  process: AgentProcess
  version?: string
  requestTimeoutMs?: number
  initializeTimeoutMs?: number
  promptTimeoutMs?: number
  closeTimeoutMs?: number
  onEvent?: (event: AcpExecutionEvent) => void
  onStderr?: (line: string) => void
  onPermissionRequest?: AcpPermissionHandler
}

export interface AcpClientState {
  initialized: InitializeResponse | undefined
  sessionId: string | undefined
  closed: boolean
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000

function asIncompatible(label: string, error: unknown): HubError {
  if (error instanceof HubError) return error
  const message = error instanceof Error ? error.message : String(error)
  // 保留 JSON-RPC 错误码：接入时靠它区分「需要登录」(-32000) 与真正的协议失败。
  const rawCode = (error as { code?: unknown }).code
  const rpcCode = typeof rawCode === 'number' ? rawCode : undefined
  return new HubError('ADAPTER_INCOMPATIBLE', `${label} 失败：${message}`, {
    label,
    ...(rpcCode === undefined ? {} : { rpcCode }),
  })
}

export class AcpClient {
  private readonly process: AgentProcess
  private readonly transport: AcpTransport
  private readonly connection: ClientConnection
  private readonly listeners = new Set<(event: AcpExecutionEvent) => void>()
  private readonly permissionHandler: AcpPermissionHandler | undefined
  private readonly requestTimeoutMs: number
  private readonly initializeTimeoutMs: number
  private readonly promptTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly version: string

  private initialized: InitializeResponse | undefined
  private sessionId: string | undefined
  private closed = false
  private disposed = false
  private transportError: HubError | undefined
  /* 进程死因要留到报错里，否则上层只看到“进程已退出”，真因（如 stdout 超限）被吞掉。 */
  private exit: AgentExit | undefined

  constructor(options: AcpClientOptions) {
    this.process = options.process
    this.version = options.version ?? '0.0.0'
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.permissionHandler = options.onPermissionRequest

    if (options.onEvent !== undefined) this.listeners.add(options.onEvent)

    this.transport = createAcpTransport(this.process, {
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      onProtocolError: (error) => {
        this.transportError = error
        this.emit({ kind: 'protocol.error', message: error.message, code: error.code })
      },
      onExit: (exit) => this.emitProcessExit(exit),
    })

    const app = createClientApp({ name: 'hubagent' })
      .onNotification('session/update', (context) => {
        // 单连接单 session；其他 session 的 update 不混入本次 transcript。
        if (this.sessionId !== undefined && context.params.sessionId !== this.sessionId) return
        this.emit(mapSessionUpdate(context.params.update))
      })
      .onRequest('session/request_permission', async (context) =>
        this.handlePermission(context.params),
      )

    this.connection = app.connect(this.transport.stream)
    void this.connection.closed
      .then(() => {
        this.closed = true
      })
      .catch(() => {
        this.closed = true
      })
  }

  get state(): AcpClientState {
    return {
      initialized: this.initialized,
      sessionId: this.sessionId,
      closed: this.closed,
    }
  }

  get agentCapabilities(): AgentCapabilities | undefined {
    return this.initialized?.agentCapabilities
  }

  supportsSessionClose(): boolean {
    const close = this.initialized?.agentCapabilities?.sessionCapabilities?.close
    return close !== undefined && close !== null
  }

  supportsSessionResume(): boolean {
    const resume = this.initialized?.agentCapabilities?.sessionCapabilities?.resume
    return resume !== undefined && resume !== null
  }

  async start(): Promise<InitializeResponse> {
    if (this.initialized !== undefined) return this.initialized
    if (this.closed) {
      throw new HubError('ADAPTER_INCOMPATIBLE', 'ACP 连接在 initialize 前已关闭')
    }

    const response = await this.withTimeout('initialize', this.initializeTimeoutMs, (options) =>
      this.connection.agent.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          // 不把宿主文件系统/终端能力交给 Agent；它只能在沙箱里用自己的工具。
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'hubagent', version: this.version },
        },
        options,
      ),
    )

    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new HubError(
        'ADAPTER_INCOMPATIBLE',
        `Agent 返回不支持的 ACP 版本 ${response.protocolVersion}（客户端支持 ${PROTOCOL_VERSION}）`,
        { protocolVersion: response.protocolVersion, supported: PROTOCOL_VERSION },
      )
    }

    this.initialized = response
    this.emit({
      kind: 'initialized',
      protocolVersion: response.protocolVersion,
      ...(response.agentInfo === undefined ? {} : { agentInfo: response.agentInfo }),
      ...(response.agentCapabilities === undefined
        ? {}
        : { agentCapabilities: response.agentCapabilities }),
    })
    return response
  }

  /**
   * 触发 Agent 的登录流程（ACP `authenticate`）。
   *
   * 只接受 agent 类型的方法；terminal 类型要求客户端起一个交互式 TUI，
   * 我们不做（也不该在任务执行期弹窗）。
   */
  async authenticate(methodId: string): Promise<void> {
    if (this.initialized === undefined) {
      throw new HubError('ADAPTER_INCOMPATIBLE', '未 initialize 就调用 authenticate')
    }
    await this.withTimeout('authenticate', this.requestTimeoutMs, (options) =>
      this.connection.agent.request('authenticate', { methodId }, options),
    )
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    if (this.initialized === undefined) {
      throw new HubError('ADAPTER_INCOMPATIBLE', '未 initialize 就调用 session/new')
    }
    if (this.sessionId !== undefined) {
      throw new HubError('ADAPTER_INCOMPATIBLE', '当前连接已有 session；M4 不并发复用')
    }

    const response = await this.withTimeout('session/new', this.requestTimeoutMs, (options) =>
      this.connection.agent.request('session/new', { cwd, mcpServers: [] }, options),
    )
    this.sessionId = response.sessionId
    this.emit({ kind: 'session.created', sessionId: response.sessionId })
    return response
  }

  async prompt(text: string): Promise<PromptResponse> {
    const sessionId = this.requireSession()
    const response = await this.withTimeout('session/prompt', this.promptTimeoutMs, (options) =>
      this.connection.agent.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
        options,
      ),
    )
    this.emit({ kind: 'prompt.finished', stopReason: response.stopReason })
    return response
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined || this.closed) return
    try {
      await this.connection.agent.notify('session/cancel', { sessionId })
    } catch (error) {
      throw asIncompatible('session/cancel', error)
    }
  }

  async closeSession(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined || this.closed || !this.supportsSessionClose()) return
    try {
      await this.withTimeout('session/close', this.closeTimeoutMs, (options) =>
        this.connection.agent.request('session/close', { sessionId }, options),
      )
    } catch {
      // 关闭是尽力而为；进程随后会被回收。
    } finally {
      this.sessionId = undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    await this.closeSession()
    try {
      this.connection.close()
    } catch {
      // 已关闭
    }
    this.transport.close()
    this.process.endInput()

    const exited = await Promise.race([
      this.process.wait().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    if (!exited) {
      await this.process.cancel()
    }
  }

  onEvent(listener: (event: AcpExecutionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get lastTransportError(): HubError | undefined {
    return this.transportError
  }

  private requireSession(): string {
    if (this.sessionId === undefined) {
      throw new HubError('ADAPTER_INCOMPATIBLE', '尚未创建 session')
    }
    return this.sessionId
  }

  private async withTimeout<T>(
    label: string,
    timeoutMs: number,
    run: (options: SendRequestOptions) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      return await run({
        cancellationSignal: controller.signal,
        stopWaitingOnCancel: true,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HubError('ADAPTER_INCOMPATIBLE', `${label} 超时（${timeoutMs}ms）`, {
          label,
          timeoutMs,
        })
      }
      if (this.closed) {
        const exit = this.exit
        throw new HubError(
          'AGENT_HOST_FAILED',
          exit === undefined
            ? `${label} 时 ACP 进程已退出`
            : `${label} 时 ACP 进程已退出（${exit.reason}）`,
          {
            label,
            ...(exit === undefined
              ? {}
              : { exitReason: exit.reason, exitCode: exit.code, exitSignal: exit.signal }),
            ...(this.transportError === undefined
              ? {}
              : { transportError: this.transportError.message }),
          },
        )
      }
      throw asIncompatible(label, error)
    } finally {
      clearTimeout(timer)
    }
  }

  private async handlePermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.sessionId === undefined || request.sessionId !== this.sessionId) {
      return { outcome: { outcome: 'cancelled' } }
    }

    let response: RequestPermissionResponse
    if (this.permissionHandler === undefined) {
      // 默认拒绝：Agent 的工具调用不等于授权（PRD §6.4.5）。
      const reject = request.options.find(
        (option) => option.kind === 'reject_once' || option.kind === 'reject_always',
      )
      response =
        reject === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: reject.optionId } }
    } else {
      response = await this.permissionHandler(request)
    }

    const outcome = response.outcome
    const selectedOptionId = outcome.outcome === 'selected' ? outcome.optionId : undefined
    const selected =
      selectedOptionId === undefined
        ? undefined
        : request.options.find((option) => option.optionId === selectedOptionId)
    const decision =
      selected === undefined
        ? outcome.outcome === 'cancelled'
          ? 'cancelled'
          : 'deny'
        : selected.kind === 'allow_once' || selected.kind === 'allow_always'
          ? 'allow'
          : 'deny'

    this.emit(permissionEvent(request, decision, selectedOptionId))
    return response
  }

  private emitProcessExit(exit: AgentExit): void {
    this.closed = true
    this.exit = exit
    this.emit({
      kind: 'process.exit',
      reason: exit.reason,
      code: exit.code,
      signal: exit.signal,
    })
  }

  private emit(event: AcpExecutionEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
