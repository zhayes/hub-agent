import { randomBytes } from 'node:crypto'
import { HubError } from '../shared/errors'
import {
  buildSrtSessionSettings,
  buildSrtSettings,
  type SrtSessionPolicy,
  type SrtSettings,
} from './settings'
import {
  assertSandboxSpec,
  networkModeOf,
  type SandboxDescription,
  type SandboxedCommand,
  type SandboxNetworkMode,
  type SandboxProvider,
  type SandboxSpec,
} from './types'

/**
 * `SandboxProvider` 的 srt 实现。
 *
 * 这一层只做三件事：把 `SandboxSpec` 翻成 srt 配置、在启动前确认隔离可用、
 * 把 srt 的失败收敛成稳定错误码。srt 的类型不越过本文件（driver 负责隔离）。
 *
 * 会话级 vs 命令级（0.0.83 的真实行为，别想当然）：
 *   - `network.allowedDomains` 的代理判定只读 `initialize()` 的会话配置；
 *     `wrap()` 里传 `customConfig.network.allowedDomains` 只影响 profile，
 *     **不会**让代理放行。单命令白名单必须 `registerCommandNetworkLists()`。
 *   - `allowLocalBinding` / `deniedDomains` 同样只在会话级生效；
 *     后续命令若要求不同值，只能重新初始化（会打断在跑的命令），因此这里
 *     fail-closed 报错，而不是静默放宽或收紧。
 *   - Windows 的 `wrap` 不支持 `allowRead/allowWrite`（srt-win 只接受 per-exec
 *     deny），所以 Windows 的写授权必须在会话初始化时给定；当前实现把首个
 *     spec 的写授权固定为会话策略，后续不一致即拒绝。
 */

/** srt `checkDependencies()` 的稳定子集 */
export interface SrtDependencyReport {
  errors: string[]
  warnings: string[]
}

/** `checkWindowsSandboxStatus()` 的稳定子集 */
export interface SrtWindowsStatus {
  userProvisioned: boolean
  groupExists: boolean
  wfpState: string
  persistentGrants?: 'present' | 'unknown'
}

export interface SrtWrapOptions {
  commandId?: string
  commandText?: string
}

/**
 * 对 `@anthropic-ai/sandbox-runtime` 的最小适配面。
 *
 * 抽出来是为了单测能在没有 srt、没有子进程的环境里验证 fail-closed 和
 * 会话/命令策略；真实实现见 `srt-driver.ts`。
 */
export interface SrtDriver {
  isSupportedPlatform(): boolean
  checkDependencies(): SrtDependencyReport
  checkWindowsStatus?(): SrtWindowsStatus
  initialize(settings: SrtSettings): Promise<void>
  wrapArgv(
    command: string,
    settings: SrtSettings,
    cwd: string,
    options?: SrtWrapOptions,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  registerCommandNetworkLists(commandId: string, lists: { allowedDomains: string[] }): void
  unregisterCommandNetworkLists(commandId: string): void
  reset(): Promise<void>
}

export const WINDOWS_INSTALL_COMMAND = 'npx @anthropic-ai/sandbox-runtime windows-install'

interface SessionSnapshot {
  key: string
  settings: SrtSettings
}

function asUnavailable(prefix: string, error: unknown): HubError {
  if (error instanceof HubError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HubError('SANDBOX_UNAVAILABLE', `${prefix}：${message}`, { cause: message })
}

function sorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort()
}

function sessionSnapshot(spec: SandboxSpec, platform: NodeJS.Platform): SessionSnapshot {
  const networkMode = networkModeOf(spec)
  if (platform === 'win32') {
    // Windows 的写授权只能在会话级下发，因此首个 spec 的 filesystem 成为会话策略。
    // 但域名仍不放进会话：代理的会话白名单会串到其他任务，域名统一走
    // per-command 注册。
    const full = buildSrtSettings(spec)
    const base = buildSrtSessionSettings({
      networkMode,
      allowLocalBinding: spec.allowLocalBinding === true,
      deniedDomains: full.network.deniedDomains,
    })
    const settings: SrtSettings = { network: base.network, filesystem: full.filesystem }
    return {
      key: JSON.stringify({
        network: {
          networkMode,
          allowLocalBinding: base.network.allowLocalBinding ?? false,
          deniedDomains: sorted(base.network.deniedDomains),
        },
        filesystem: {
          denyRead: sorted(settings.filesystem.denyRead),
          allowRead: sorted(settings.filesystem.allowRead),
          allowWrite: sorted(settings.filesystem.allowWrite),
          denyWrite: sorted(settings.filesystem.denyWrite),
        },
      }),
      settings,
    }
  }

  const policy: SrtSessionPolicy = {
    networkMode,
    allowLocalBinding: spec.allowLocalBinding === true,
    deniedDomains: sorted(spec.deniedDomains ?? []),
  }
  return {
    key: JSON.stringify({
      networkMode: policy.networkMode,
      allowLocalBinding: policy.allowLocalBinding,
      deniedDomains: policy.deniedDomains,
    }),
    settings: buildSrtSessionSettings(policy),
  }
}

/**
 * 把命令级配置里「不该由单命令决定」的字段拿掉。
 *
 * - POSIX：`allowLocalBinding` / `deniedDomains` 已在会话级固定；
 *   `allowedDomains` 保留（profile 与凭据注入仍要它），代理放行靠注册。
 * - Windows：per-exec 只接受 deny，传 allow 会直接抛错；写授权留在会话级。
 */
function perCommandSettings(
  settings: SrtSettings,
  platform: NodeJS.Platform,
  networkMode: SandboxNetworkMode,
): SrtSettings {
  if (platform === 'win32') {
    return {
      network: {
        ...(networkMode === 'agent-managed'
          ? {}
          : { allowedDomains: settings.network.allowedDomains ?? [] }),
        deniedDomains: settings.network.deniedDomains,
      },
      filesystem: {
        denyRead: settings.filesystem.denyRead,
        allowRead: [],
        allowWrite: [],
        denyWrite: settings.filesystem.denyWrite,
      },
    }
  }

  return {
    network: {
      ...(networkMode === 'agent-managed'
        ? {}
        : { allowedDomains: settings.network.allowedDomains ?? [] }),
      deniedDomains: [],
    },
    filesystem: settings.filesystem,
  }
}

export function windowsSandboxIssues(status: SrtWindowsStatus): string[] {
  const issues: string[] = []
  if (!status.userProvisioned) {
    issues.push(`Windows 沙箱未安装（缺少 srt-sandbox 账户）：运行 ${WINDOWS_INSTALL_COMMAND}`)
  }
  if (!status.groupExists) {
    issues.push(
      `Windows 沙箱用户组 sandbox-runtime-users 不存在：重新运行 ${WINDOWS_INSTALL_COMMAND}`,
    )
  }
  if (status.wfpState === 'absent') {
    issues.push(`Windows WFP 出网围栏未安装：重新运行 ${WINDOWS_INSTALL_COMMAND}`)
  }
  if (status.wfpState === 'loopback-mismatch') {
    issues.push(`Windows 沙箱的 loopback 模式与当前配置不一致：重新运行 ${WINDOWS_INSTALL_COMMAND}`)
  }
  if (status.persistentGrants === 'present') {
    issues.push('Windows 沙箱存在未释放的持久写授权：先运行 srt-win acl forget --all')
  }
  return issues
}

export class SrtProvider implements SandboxProvider {
  private readonly driver: SrtDriver
  private readonly platform: NodeJS.Platform
  private initPromise: Promise<void> | undefined
  private sessionKey: string | undefined
  private disposed = false
  private readonly networkKeys = new Set<string>()

  constructor(driver: SrtDriver, platform: NodeJS.Platform = process.platform) {
    this.driver = driver
    this.platform = platform
  }

  describe(): SandboxDescription {
    const base = { kind: 'srt' as const, platform: this.platform }
    if (this.disposed) {
      return { ...base, ready: false, detail: '沙箱提供者已释放' }
    }

    const readiness = this.readiness()
    if (readiness.issues.length > 0) {
      return { ...base, ready: false, detail: readiness.issues.join('；') }
    }
    return {
      ...base,
      ready: true,
      detail:
        readiness.warnings.length > 0
          ? `沙箱依赖就绪；警告：${readiness.warnings.join('；')}`
          : '沙箱依赖就绪',
    }
  }

  async wrap(command: string, spec: SandboxSpec): Promise<SandboxedCommand> {
    if (this.disposed) {
      throw new HubError('SANDBOX_UNAVAILABLE', '沙箱提供者已释放，拒绝执行')
    }
    if (command.trim().length === 0) {
      throw new HubError('SANDBOX_UNAVAILABLE', '命令不能为空')
    }
    assertSandboxSpec(spec)
    this.ensureReady()
    await this.ensureInitialized(spec)

    const networkMode = networkModeOf(spec)
    const settings = buildSrtSettings(spec)
    const allowedDomains =
      networkMode === 'allowlist' ? (settings.network.allowedDomains ?? []) : []

    // 只有需要单命令域名时，才生成不可猜的 key（srt 要求 >=22 字符、
    // 至少 128 bit 随机；ULID / 计数器都不满足）。
    const networkKey = allowedDomains.length > 0 ? randomBytes(16).toString('base64url') : undefined

    if (networkKey !== undefined) {
      try {
        this.driver.registerCommandNetworkLists(networkKey, { allowedDomains })
        this.networkKeys.add(networkKey)
      } catch (error) {
        throw asUnavailable('注册 per-command 网络白名单失败', error)
      }
    }

    const options: SrtWrapOptions | undefined =
      networkKey !== undefined
        ? {
            commandId: networkKey,
            ...(spec.commandId === undefined ? {} : { commandText: spec.commandId }),
          }
        : spec.commandId === undefined
          ? undefined
          : { commandId: spec.commandId }

    try {
      const result = await this.driver.wrapArgv(
        command,
        perCommandSettings(settings, this.platform, networkMode),
        spec.cwd,
        options,
      )
      return {
        argv: result.argv,
        // 显式叠加 spec.env；不改写进程环境，也不做隐式筛选。
        env: { ...result.env, ...(spec.env ?? {}) },
        ...(networkKey === undefined ? {} : { commandId: networkKey }),
      }
    } catch (error) {
      if (networkKey !== undefined) this.release(networkKey)
      throw asUnavailable('沙箱包装命令失败', error)
    }
  }

  release(commandId: string): void {
    if (!this.networkKeys.delete(commandId)) return
    try {
      this.driver.unregisterCommandNetworkLists(commandId)
    } catch {
      // 释放失败不应掩盖任务本身的结果；dispose() 会再兜底清理一次。
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const key of this.networkKeys) {
      try {
        this.driver.unregisterCommandNetworkLists(key)
      } catch {
        // 尽力清理
      }
    }
    this.networkKeys.clear()
    this.initPromise = undefined
    this.sessionKey = undefined
    try {
      await this.driver.reset()
    } catch (error) {
      throw asUnavailable('释放沙箱失败', error)
    }
  }

  private readiness(): { issues: string[]; warnings: string[] } {
    try {
      if (!this.driver.isSupportedPlatform()) {
        return {
          issues: [`当前平台（${this.platform}）不支持系统级沙箱，拒绝执行`],
          warnings: [],
        }
      }
      const deps = this.driver.checkDependencies()
      const issues = [...deps.errors]
      const warnings = [...deps.warnings]
      if (this.platform === 'win32') {
        try {
          const status = this.driver.checkWindowsStatus?.()
          if (status !== undefined) issues.push(...windowsSandboxIssues(status))
        } catch (error) {
          issues.push(
            `Windows 沙箱状态检查失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return { issues, warnings }
    } catch (error) {
      return {
        issues: [`沙箱依赖检查失败：${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      }
    }
  }

  private ensureReady(): void {
    const readiness = this.readiness()
    if (readiness.issues.length === 0) return

    const message = readiness.issues.join('；')
    if (this.platform === 'win32') {
      throw new HubError('SANDBOX_NOT_PROVISIONED', message, {
        platform: this.platform,
        issues: readiness.issues,
        install: WINDOWS_INSTALL_COMMAND,
      })
    }
    throw new HubError('SANDBOX_UNAVAILABLE', message, {
      platform: this.platform,
      issues: readiness.issues,
    })
  }

  private async ensureInitialized(spec: SandboxSpec): Promise<void> {
    const snapshot = sessionSnapshot(spec, this.platform)

    if (this.initPromise === undefined) {
      this.sessionKey = snapshot.key
      this.initPromise = this.driver.initialize(snapshot.settings).catch((error: unknown) => {
        // 初始化失败不缓存：下次 wrap 可以重试（例如刚装完依赖）。
        this.initPromise = undefined
        this.sessionKey = undefined
        throw asUnavailable('沙箱初始化失败', error)
      })
    }

    await this.initPromise

    if (this.sessionKey !== snapshot.key) {
      throw new HubError(
        'SANDBOX_UNAVAILABLE',
        '会话级沙箱策略在首个命令后发生变化（networkMode / allowLocalBinding / deniedDomains / 写授权），拒绝执行',
        { reason: 'session_policy_changed', platform: this.platform },
      )
    }
  }
}
