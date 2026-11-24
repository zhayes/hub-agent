import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { SandboxedCommand, SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import type {
  AgentExit,
  AgentExitReason,
  AgentProcess,
  AgentProcessEvent,
  AgentTimeouts,
} from './types'

export interface SandboxedAgentProcessOptions {
  id: string
  provider: SandboxProvider
  wrapped: SandboxedCommand
  worktree: string
  timeouts: AgentTimeouts
  maxStdoutBytes: number
  maxStderrBytes: number
}

type StreamName = 'stdout' | 'stderr'

/**
 * 一个受 AgentHost 监管的沙箱子进程。
 *
 * 不变量：
 *   1. spawn 的 cwd 永远等于 worktree（构造参数只有 worktree）。
 *   2. 退出路径只有一条：`finalize()`；超时、取消、自然退出、spawn 失败都走它。
 *   3. 只要提供了 `wrapped.commandId`，退出时一定 `release()`。
 *   4. 进程组统一收尸：POSIX 用负 pid，Windows 用 taskkill /T /F。
 */
export class SandboxedAgentProcess implements AgentProcess {
  readonly id: string
  private readonly provider: SandboxProvider
  private readonly wrapped: SandboxedCommand
  private readonly child: ChildProcessWithoutNullStreams
  private readonly timeouts: AgentTimeouts
  private readonly maxBytes: Record<StreamName, number>
  private readonly startedAt = Date.now()
  private readonly listeners = new Set<(event: AgentProcessEvent) => void>()
  private readonly exitPromise: Promise<AgentExit>
  private resolveExit!: (exit: AgentExit) => void

  private exitResult: AgentExit | undefined
  private exitReason: AgentExitReason | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private totalTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private readonly output: Record<StreamName, string> = { stdout: '', stderr: '' }
  private readonly lineBuffers: Record<StreamName, string> = { stdout: '', stderr: '' }
  private readonly bytes: Record<StreamName, number> = { stdout: 0, stderr: 0 }
  private readonly truncated: Record<StreamName, boolean> = { stdout: false, stderr: false }
  private firstOutput = false
  private settled = false

  constructor(options: SandboxedAgentProcessOptions) {
    const [file, ...args] = options.wrapped.argv
    if (file === undefined || file.length === 0) {
      throw new HubError('AGENT_HOST_FAILED', '沙箱返回了空 argv，拒绝启动')
    }

    this.id = options.id
    this.provider = options.provider
    this.wrapped = options.wrapped
    this.timeouts = options.timeouts
    this.maxBytes = {
      stdout: options.maxStdoutBytes,
      stderr: options.maxStderrBytes,
    }

    this.exitPromise = new Promise<AgentExit>((resolve) => {
      this.resolveExit = resolve
    })

    this.child = spawn(file, args, {
      cwd: options.worktree,
      env: { ...options.wrapped.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX：新进程组，取消时用 -pid 一次收掉整棵树。
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams

    this.attachHandlers()
    this.armTimers()
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get exit(): AgentExit | undefined {
    return this.exitResult
  }

  writeLine(line: string): boolean {
    if (this.exitResult !== undefined || !this.child.stdin.writable) return false
    assertSingleLine(line)
    try {
      this.child.stdin.write(`${line}\n`)
      return true
    } catch {
      return false
    }
  }

  async writeLineAsync(line: string): Promise<void> {
    if (this.exitResult !== undefined) {
      throw new HubError('AGENT_HOST_FAILED', `进程 ${this.id} 已退出，无法写入 stdin`)
    }
    assertSingleLine(line)
    const stdin = this.child.stdin
    if (!stdin.writable) {
      throw new HubError('AGENT_HOST_FAILED', `进程 ${this.id} 的 stdin 已关闭`)
    }

    const accepted = stdin.write(`${line}\n`)
    if (accepted) return

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
        this.child.off('close', onClose)
      }
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(new HubError('AGENT_HOST_FAILED', `写入 stdin 失败：${error.message}`))
      }
      const onClose = (): void => {
        cleanup()
        reject(new HubError('AGENT_HOST_FAILED', `进程 ${this.id} 在 drain 前退出`))
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
      this.child.once('close', onClose)
    })
  }

  endInput(): void {
    if (this.child.stdin.writable) this.child.stdin.end()
  }

  async cancel(): Promise<AgentExit> {
    if (this.exitResult !== undefined) return this.exitResult
    this.terminate('canceled')
    return this.wait()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.signalGroup(signal)
  }

  wait(): Promise<AgentExit> {
    return this.exitPromise
  }

  onEvent(listener: (event: AgentProcessEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attachHandlers(): void {
    this.child.once('spawn', () => {
      const pid = this.child.pid
      if (pid !== undefined) this.emit({ type: 'spawned', pid })
    })

    this.child.stdout.on('data', (chunk: Buffer) => this.onData('stdout', chunk))
    this.child.stderr.on('data', (chunk: Buffer) => this.onData('stderr', chunk))

    this.child.once('error', (error: Error) => {
      this.finalize(null, null, 'spawn_error', error.message)
    })

    // close 而不是 exit：确保 stdout/stderr 已经 drain 完，最后一行不丢。
    this.child.once('close', (code, signal) => {
      this.finalize(code, signal, this.exitReason ?? 'exited')
    })

    // 子进程提前退出时写 stdin 会 EPIPE；不让它变成未处理异常。
    this.child.stdin.on('error', () => {})
  }

  private armTimers(): void {
    this.totalTimer = setTimeout(() => this.terminate('total_timeout'), this.timeouts.totalMs)
    this.startupTimer = setTimeout(() => this.terminate('startup_timeout'), this.timeouts.startupMs)
  }

  private armIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.terminate('idle_timeout'), this.timeouts.idleMs)
  }

  private clearLifecycleTimers(): void {
    for (const timer of [this.startupTimer, this.idleTimer, this.totalTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.startupTimer = undefined
    this.idleTimer = undefined
    this.totalTimer = undefined
  }

  private onData(stream: StreamName, chunk: Buffer): void {
    if (this.settled) return

    if (!this.firstOutput) {
      this.firstOutput = true
      if (this.startupTimer !== undefined) {
        clearTimeout(this.startupTimer)
        this.startupTimer = undefined
      }
    }
    this.armIdle()

    const cap = this.maxBytes[stream]
    const used = this.bytes[stream]
    if (used >= cap) {
      this.truncated[stream] = true
      this.terminate('output_limit')
      return
    }

    const remaining = cap - used
    const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    this.bytes[stream] += accepted.length
    const text = accepted.toString('utf8')
    this.output[stream] += text
    this.lineBuffers[stream] += text
    this.flushLines(stream)

    if (chunk.length > remaining) {
      this.truncated[stream] = true
      this.terminate('output_limit')
    }
  }

  private flushLines(stream: StreamName): void {
    let newline = this.lineBuffers[stream].indexOf('\n')
    while (newline >= 0) {
      let line = this.lineBuffers[stream].slice(0, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.lineBuffers[stream] = this.lineBuffers[stream].slice(newline + 1)
      this.emit(stream === 'stdout' ? { type: 'stdout', line } : { type: 'stderr', line })
      newline = this.lineBuffers[stream].indexOf('\n')
    }
  }

  private flushRemaining(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.lineBuffers[stream]
      if (rest.length === 0) continue
      const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
      this.lineBuffers[stream] = ''
      this.emit(stream === 'stdout' ? { type: 'stdout', line } : { type: 'stderr', line })
    }
  }

  private terminate(reason: AgentExitReason): void {
    if (this.settled) return
    if (this.exitReason === undefined) this.exitReason = reason
    this.clearLifecycleTimers()
    this.signalGroup('SIGTERM')

    if (this.killTimer === undefined) {
      this.killTimer = setTimeout(() => {
        this.killTimer = undefined
        this.signalGroup('SIGKILL')
      }, this.timeouts.killGraceMs)
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return

    if (process.platform === 'win32') {
      try {
        this.child.kill(signal)
      } catch {
        // 父进程可能已经退出；继续尝试 taskkill。
      }
      if (signal === 'SIGKILL') {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.on('error', () => {})
        } catch {
          // 没有 taskkill 时只能依赖 child.kill。
        }
      }
      return
    }

    try {
      // detached: true 让子进程成为新进程组组长，负 pid 覆盖整棵树。
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          this.child.kill(signal)
        } catch {
          // 进程已退出
        }
      }
    }
  }

  private finalize(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: AgentExitReason,
    error?: string,
  ): void {
    if (this.settled) return
    this.settled = true
    this.clearLifecycleTimers()
    if (this.killTimer !== undefined) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    this.flushRemaining()

    if (this.wrapped.commandId !== undefined) {
      this.provider.release?.(this.wrapped.commandId)
    }

    const exit: AgentExit = {
      code,
      signal,
      reason,
      durationMs: Date.now() - this.startedAt,
      stdout: this.output.stdout,
      stderr: this.output.stderr,
      stdoutTruncated: this.truncated.stdout,
      stderrTruncated: this.truncated.stderr,
      ...(error === undefined ? {} : { error }),
    }
    this.exitResult = exit
    this.emit({ type: 'exit', exit })
    this.resolveExit(exit)
  }

  private emit(event: AgentProcessEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function assertSingleLine(line: string): void {
  if (line.includes('\n') || line.includes('\r')) {
    throw new HubError('AGENT_HOST_FAILED', 'writeLine 只接受单行文本')
  }
}
