import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SandboxSpec } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { SandboxedAgentProcess } from './process'
import {
  type AgentExit,
  type AgentHostEvent,
  type AgentHostOptions,
  type AgentProcess,
  type AgentSpawnRequest,
  type AgentTimeouts,
  DEFAULT_AGENT_TIMEOUTS,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
} from './types'

/**
 * M3 的 AgentHost：只做进程监管，不做 ACP 会话。
 *
 * 它把「所有子进程必须经 SandboxProvider」变成结构约束：
 *   - 调用方给 `worktree`，不给 cwd；AgentHost 自己填 `SandboxSpec.cwd`。
 *   - 启动失败（沙箱不可用、worktree 非法、命令为空）不会注册任何进程。
 *   - 每个进程退出都会走 `release()`，per-command 网络白名单不会泄漏。
 *
 * 它刻意不 import storage：这个层不应该有机会写任务记录。任务记录由
 * Runtime 在拿到 spawn 成功之后再写。
 */
export class AgentHost {
  private readonly provider: AgentHostOptions['provider']
  private readonly defaultTimeouts: AgentTimeouts
  private readonly defaultMaxStdoutBytes: number
  private readonly defaultMaxStderrBytes: number
  private readonly active = new Map<string, AgentProcess>()
  private readonly listeners = new Set<(event: AgentHostEvent) => void>()
  private disposed = false

  constructor(options: AgentHostOptions) {
    this.provider = options.provider
    this.defaultTimeouts = resolveTimeouts(DEFAULT_AGENT_TIMEOUTS, options.timeouts)
    this.defaultMaxStdoutBytes = resolveBytes(
      'maxStdoutBytes',
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
    )
    this.defaultMaxStderrBytes = resolveBytes(
      'maxStderrBytes',
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
    )
  }

  async spawn(id: string, request: AgentSpawnRequest): Promise<AgentProcess> {
    if (this.disposed) {
      throw new HubError('AGENT_HOST_FAILED', 'AgentHost 已释放，拒绝启动新进程')
    }
    if (id.trim().length === 0) {
      throw new HubError('AGENT_HOST_FAILED', '进程 id 不能为空')
    }
    if (request.command.trim().length === 0) {
      throw new HubError('AGENT_HOST_FAILED', '命令不能为空')
    }
    if (this.active.has(id)) {
      throw new HubError('AGENT_HOST_FAILED', `进程 id 已存在：${id}`, { id })
    }
    assertWorktree(request.worktree)

    const spec: SandboxSpec = {
      ...(request.sandbox ?? { allowedWrite: [] }),
      // 唯一来源：cwd 由 worktree 填，调用方没有第二个入口。
      cwd: request.worktree,
    }

    // 参数错误必须在碰 provider 之前拒绝：否则一次非法启动也可能把
    // 沙箱会话初始化起来，并触发副作用。
    const timeouts = resolveTimeouts(this.defaultTimeouts, request.timeouts)
    const maxStdoutBytes = resolveBytes(
      'maxStdoutBytes',
      request.maxStdoutBytes,
      this.defaultMaxStdoutBytes,
    )
    const maxStderrBytes = resolveBytes(
      'maxStderrBytes',
      request.maxStderrBytes,
      this.defaultMaxStderrBytes,
    )

    let wrapped: Awaited<ReturnType<AgentHostOptions['provider']['wrap']>>
    try {
      wrapped = await this.provider.wrap(request.command, spec)
    } catch (error) {
      throw asHostError('沙箱包装失败', error)
    }

    try {
      const process = new SandboxedAgentProcess({
        id,
        provider: this.provider,
        wrapped,
        worktree: request.worktree,
        timeouts,
        maxStdoutBytes,
        maxStderrBytes,
      })
      this.active.set(id, process)

      let unsubscribe: (() => void) | undefined
      unsubscribe = process.onEvent((event) => {
        if (event.type === 'exit') {
          if (this.active.get(id) === process) this.active.delete(id)
          unsubscribe?.()
        }
        this.emit({ id, ...event } as AgentHostEvent)
      })

      return process
    } catch (error) {
      // 进程没起来，但 per-command 白名单可能已经注册，必须交回。
      if (wrapped.commandId !== undefined) this.provider.release?.(wrapped.commandId)
      throw asHostError('启动沙箱进程失败', error)
    }
  }

  get(id: string): AgentProcess | undefined {
    return this.active.get(id)
  }

  activeCount(): number {
    return this.active.size
  }

  async kill(id: string): Promise<AgentExit | undefined> {
    const process = this.active.get(id)
    if (process === undefined) return undefined
    return process.cancel()
  }

  async killAll(): Promise<void> {
    const processes = [...this.active.values()]
    await Promise.all(processes.map((process) => process.cancel()))
  }

  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 停止所有进程并清空监听。**不**释放 provider——provider 由调用方持有，
   * daemon 关闭时通常接着 `provider.dispose()`。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.killAll()
    this.listeners.clear()
    this.active.clear()
  }

  private emit(event: AgentHostEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function asHostError(prefix: string, error: unknown): HubError {
  if (error instanceof HubError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HubError('AGENT_HOST_FAILED', `${prefix}：${message}`, { cause: message })
}

function assertWorktree(worktree: string): void {
  if (!isAbsolute(worktree)) {
    throw new HubError('AGENT_HOST_FAILED', `worktree 必须是绝对路径：${worktree}`, { worktree })
  }
  try {
    if (!statSync(worktree).isDirectory()) {
      throw new HubError('AGENT_HOST_FAILED', `worktree 不是目录：${worktree}`, { worktree })
    }
  } catch (error) {
    if (error instanceof HubError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new HubError('AGENT_HOST_FAILED', `worktree 不可用：${worktree}（${message}）`, {
      worktree,
      cause: message,
    })
  }
}

function resolveTimeouts(base: AgentTimeouts, overrides?: Partial<AgentTimeouts>): AgentTimeouts {
  const merged = { ...base, ...(overrides ?? {}) }
  for (const key of ['startupMs', 'idleMs', 'totalMs'] as const) {
    const value = merged[key]
    if (!Number.isFinite(value) || value <= 0) {
      throw new HubError('AGENT_HOST_FAILED', `${key} 必须是正数：${value}`)
    }
  }
  if (!Number.isFinite(merged.killGraceMs) || merged.killGraceMs < 0) {
    throw new HubError('AGENT_HOST_FAILED', `killGraceMs 必须是非负数：${merged.killGraceMs}`)
  }
  return merged
}

function resolveBytes(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new HubError('AGENT_HOST_FAILED', `${name} 必须是正整数：${resolved}`)
  }
  return resolved
}
