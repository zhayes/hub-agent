import { isAbsolute } from 'node:path'
import { HubError } from '../shared/errors'

/**
 * 沙箱抽象层（ARCHITECTURE §12.1）。
 *
 * 原则：
 *   1. 上层只认识 `SandboxedCommand = { argv, env }`，不认识 srt 的任何类型；
 *      这样换实现（自研 bwrap 包装、容器）不需要动 AgentHost。
 *   2. 所有路径都必须是绝对路径——相对路径的语义取决于进程 cwd，
 *      而 cwd 恰恰是这层要强制的东西，用它做基准会自相矛盾。
 *   3. 未就绪即拒绝（fail-closed），没有 `enabled: false` 这种开关。
 */

export type SandboxNetworkMode = 'agent-managed' | 'allowlist' | 'deny'

export interface SandboxSpec {
  /** 任务工作区绝对路径；同时作为进程 cwd（ADR 0002 C2） */
  cwd: string
  /** 允许写入的绝对路径（不含 cwd 时会被自动补上） */
  allowedWrite: readonly string[]
  /** 额外的拒绝读路径；默认值见 settings.ts 的 DEFAULT_DENY_READ */
  denyRead?: readonly string[]
  /**
   * 网络策略：
   *   - agent-managed（默认）：不套网络白名单，Agent 自己负责模型/外部资源；
   *     文件与凭据边界仍然强制。
   *   - allowlist：只允许白名单域名；未声明即拒绝。
   *   - deny：禁止一切出网。
   * 未显式设置时：给了 allowedDomains/deniedDomains 视为 allowlist，否则 agent-managed。
   */
  networkMode?: SandboxNetworkMode
  /** 仅 allowlist 模式使用；allowlist 下空数组 = 全禁 */
  allowedDomains?: readonly string[]
  deniedDomains?: readonly string[]
  /** 需要直连本机端口时开启（dev server / 集成测试） */
  allowLocalBinding?: boolean
  /** 额外透传的环境变量（只做显式叠加，不做筛选） */
  env?: Readonly<Record<string, string>>
  /** 单条命令的超时；由 AgentHost 执行，Provider 只透传 */
  timeoutMs?: number
  /** 违规归因键，透传给底层（便于把 violation 归到具体执行） */
  commandId?: string
}

/** 唯一允许跨层流动的形态：直接可交给 spawn */
export interface SandboxedCommand {
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  /**
   * 需要调用方在子进程退出（或启动失败）后交回 `SandboxProvider.release()`
   * 的 per-command 资源键。当前只有 per-command 网络白名单需要释放。
   */
  commandId?: string
}

export interface SandboxDescription {
  readonly kind: 'srt'
  readonly platform: NodeJS.Platform
  readonly ready: boolean
  readonly detail: string
}

export interface SandboxProvider {
  describe(): SandboxDescription
  /**
   * 把一条命令包成受隔离的可执行形态。
   *
   * fail-closed：依赖缺失 / 初始化失败时抛 `SANDBOX_UNAVAILABLE`，
   * 调用方必须原样上抛，不得降级为无隔离执行。
   */
  wrap(command: string, spec: SandboxSpec): Promise<SandboxedCommand>
  /**
   * 释放 wrap 返回的 per-command 资源。必须在子进程退出或启动失败后调用，
   * 且必须幂等；实现不得因释放失败而掩盖任务本身的错误。
   */
  release?(commandId: string): void
  dispose(): Promise<void>
}

export function networkModeOf(spec: SandboxSpec): SandboxNetworkMode {
  if (spec.networkMode !== undefined) return spec.networkMode
  if ((spec.allowedDomains?.length ?? 0) > 0 || (spec.deniedDomains?.length ?? 0) > 0) {
    return 'allowlist'
  }
  return 'agent-managed'
}

/** 校验 spec 的静态约束；在 wrap 之前调用，错误尽早暴露 */
export function assertSandboxSpec(spec: SandboxSpec): void {
  if (
    spec.networkMode !== undefined &&
    spec.networkMode !== 'agent-managed' &&
    spec.networkMode !== 'allowlist' &&
    spec.networkMode !== 'deny'
  ) {
    throw new HubError('SANDBOX_UNAVAILABLE', `未知的 networkMode：${String(spec.networkMode)}`)
  }
  if (!isAbsolute(spec.cwd)) {
    throw new HubError('SANDBOX_UNAVAILABLE', `沙箱 cwd 必须是绝对路径：${spec.cwd}`, {
      cwd: spec.cwd,
    })
  }
  for (const path of spec.allowedWrite) {
    if (!isAbsolute(path)) {
      throw new HubError('SANDBOX_UNAVAILABLE', `allowedWrite 必须是绝对路径：${path}`, { path })
    }
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    throw new HubError('SANDBOX_UNAVAILABLE', `timeoutMs 必须为正数：${spec.timeoutMs}`)
  }
  if (
    spec.networkMode === 'agent-managed' &&
    ((spec.allowedDomains?.length ?? 0) > 0 || (spec.deniedDomains?.length ?? 0) > 0)
  ) {
    throw new HubError(
      'SANDBOX_UNAVAILABLE',
      'networkMode=agent-managed 时不能同时传 allowedDomains/deniedDomains；需要白名单请显式设 networkMode=allowlist',
    )
  }
  if (spec.networkMode === 'deny' && (spec.allowedDomains?.length ?? 0) > 0) {
    throw new HubError('SANDBOX_UNAVAILABLE', 'networkMode=deny 时不能传 allowedDomains')
  }
}
