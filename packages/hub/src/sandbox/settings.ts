import { networkModeOf, type SandboxNetworkMode, type SandboxSpec } from './types'

/**
 * SandboxSpec → srt settings（ARCHITECTURE §12.1 的默认策略）。
 *
 * 两个容易配反的地方，这里写清楚：
 *   - **读**是「默认放行 + 显式 deny」：不写 denyRead 就等于凭据可读。
 *   - **写**是「默认拒绝 + 显式 allow」：allowWrite 为空即完全不可写。
 *   而且两者优先级相反：allowRead 覆盖 denyRead；denyWrite 覆盖 allowWrite。
 */

/** 凭据目录：默认拒绝读取（PRD §6.9.7） */
export const DEFAULT_DENY_READ: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.kube',
  '~/.gnupg',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.config/gh',
]

/** 即使在工作区内也不该被任务改写的文件 */
export const DEFAULT_DENY_WRITE: readonly string[] = ['.env', '.env.*']

export interface SrtSettings {
  network: {
    /** 仅在 allowlist / deny 模式出现；缺省 = 不做网络隔离（agent-managed） */
    allowedDomains?: string[]
    deniedDomains: string[]
    allowLocalBinding?: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/**
 * 生成 srt 的运行时配置。
 *
 * `cwd` 一定进入 allowWrite：任务必须在自己的 worktree 里能写，
 * 否则连 `git commit` 都跑不了（TC-014 的"误伤"一侧）。
 */
export function buildSrtSettings(spec: SandboxSpec): SrtSettings {
  const mode = networkModeOf(spec)
  const network =
    mode === 'agent-managed'
      ? {
          deniedDomains: [],
          ...(spec.allowLocalBinding === undefined
            ? {}
            : { allowLocalBinding: spec.allowLocalBinding }),
        }
      : {
          allowedDomains: mode === 'deny' ? [] : unique(spec.allowedDomains ?? []),
          deniedDomains: unique(spec.deniedDomains ?? []),
          ...(spec.allowLocalBinding === undefined
            ? {}
            : { allowLocalBinding: spec.allowLocalBinding }),
        }

  return {
    network,
    filesystem: {
      denyRead: unique([...DEFAULT_DENY_READ, ...(spec.denyRead ?? [])]),
      // 默认不额外放行读；需要时由 spec 的 denyRead 反向收窄
      allowRead: [],
      allowWrite: unique([spec.cwd, ...spec.allowedWrite]),
      denyWrite: unique(DEFAULT_DENY_WRITE),
    },
  }
}

/** 会话级策略：这些字段在 `initialize()` 后固定，不能按命令改变 */
export interface SrtSessionPolicy {
  /** 默认 agent-managed：会话不安装网络代理，交给 Agent 自己 */
  networkMode?: SandboxNetworkMode
  allowLocalBinding?: boolean
  deniedDomains?: readonly string[]
}

/**
 * 生成 `SandboxManager.initialize()` 用的基线配置。
 *
 * 为什么基线故意「什么都不给」：
 *   - `allowWrite` 为空：写授权是 per-command 的，基线放行会让 A 任务的
 *     命令拥有 B 任务 worktree 的写权限。
 *   - `allowedDomains` 不放进会话基线：allowlist 模式按命令在 wrap 前注册
 *     （`registerCommandNetworkLists`），否则会串任务；agent-managed 则直接不装代理。
 *   - 凭据目录仍然默认拒绝：这是全局底线，不随任务变化。
 */
export function buildSrtSessionSettings(policy: SrtSessionPolicy = {}): SrtSettings {
  const mode = policy.networkMode ?? 'agent-managed'
  const network =
    mode === 'agent-managed'
      ? {
          deniedDomains: [],
          ...(policy.allowLocalBinding === undefined
            ? {}
            : { allowLocalBinding: policy.allowLocalBinding }),
        }
      : {
          allowedDomains: [],
          deniedDomains: unique(policy.deniedDomains ?? []),
          ...(policy.allowLocalBinding === undefined
            ? {}
            : { allowLocalBinding: policy.allowLocalBinding }),
        }

  return {
    network,
    filesystem: {
      denyRead: unique(DEFAULT_DENY_READ),
      allowRead: [],
      allowWrite: [],
      denyWrite: unique(DEFAULT_DENY_WRITE),
    },
  }
}
