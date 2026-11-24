import type { SandboxProvider, SandboxSpec } from '../sandbox/types'

/**
 * AgentHost 的进程级契约（M3）。
 *
 * 这一层只管「把一个命令安全地跑起来、看得见输出、一定能收尸」；
 * ACP 的 initialize / session / prompt 属于 M4，不在这里假装实现。
 */

/** 三层超时 + 终止宽限 */
export interface AgentTimeouts {
  /** 从 spawn 到第一段 stdout/stderr 的时间（ACP 握手期的上限） */
  startupMs: number
  /** 首段输出之后，两段输出之间的最大间隔（卡住检测） */
  idleMs: number
  /** 进程总生命周期硬上限 */
  totalMs: number
  /** SIGTERM 到 SIGKILL 之间的宽限 */
  killGraceMs: number
}

export type AgentExitReason =
  | 'exited'
  | 'canceled'
  | 'startup_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'output_limit'
  | 'spawn_error'

export interface AgentExit {
  code: number | null
  signal: NodeJS.Signals | null
  reason: AgentExitReason
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** spawn 失败时的原始错误信息；其他情况不出现 */
  error?: string
}

export type AgentProcessEvent =
  | { type: 'spawned'; pid: number }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; exit: AgentExit }

export type AgentHostEvent = AgentProcessEvent & { id: string }

export interface AgentSpawnRequest {
  /**
   * 任务工作区绝对路径。AgentHost 用它同时作为 `SandboxSpec.cwd` 与
   * spawn 的 `cwd`——调用方没有单独传 cwd 的入口，从结构上保证 C2。
   */
  worktree: string
  /** 交给 `SandboxProvider.wrap()` 的命令字符串 */
  command: string
  /** 沙箱策略；cwd 由 worktree 强制，不允许在这里传 */
  sandbox?: Omit<SandboxSpec, 'cwd'>
  /** 覆盖默认三层超时 */
  timeouts?: Partial<AgentTimeouts>
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

/** 一个已启动（或正在启动）的受管进程 */
export interface AgentProcess {
  readonly id: string
  readonly pid: number | undefined
  readonly exit: AgentExit | undefined
  /** 写入一行并补 `\n`；stdin 不可写时返回 false。行内不允许换行 */
  writeLine(line: string): boolean
  /** 写入一行；遇到背压时等待 drain，进程退出/错误时 reject */
  writeLineAsync(line: string): Promise<void>
  endInput(): void
  /** 优雅终止：SIGTERM → 宽限 → SIGKILL；幂等 */
  cancel(reason?: string): Promise<AgentExit>
  /** 直接给进程组发信号；一般用 cancel */
  kill(signal?: NodeJS.Signals): void
  /** 进程退出（含超时/取消/spawn 失败）后 resolve，不 reject */
  wait(): Promise<AgentExit>
  onEvent(listener: (event: AgentProcessEvent) => void): () => void
}

export interface AgentHostOptions {
  provider: SandboxProvider
  timeouts?: Partial<AgentTimeouts>
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export const DEFAULT_AGENT_TIMEOUTS: AgentTimeouts = {
  startupMs: 30_000,
  idleMs: 120_000,
  totalMs: 30 * 60_000,
  killGraceMs: 5_000,
}

export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024
