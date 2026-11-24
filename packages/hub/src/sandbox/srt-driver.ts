import { readFile } from 'node:fs/promises'
import {
  checkWindowsSandboxStatus,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import type { SrtSettings } from './settings'
import {
  type SrtDependencyReport,
  type SrtDriver,
  SrtProvider,
  type SrtWindowsStatus,
  windowsSandboxIssues,
} from './srt-provider'

/**
 * 真实 srt 适配层。
 *
 * 这是 `sandbox/**` 里唯一 import `@anthropic-ai/sandbox-runtime` 的文件：
 * 换实现（自研 bwrap / Seatbelt / 容器）时只改这里。
 */

function normalizeWindowsStatus(
  status: ReturnType<typeof checkWindowsSandboxStatus>,
): SrtWindowsStatus {
  return {
    userProvisioned: status.user.provisioned,
    groupExists: status.user.groupExists,
    wfpState: status.wfp.state,
    ...(status.user.persistentGrants === undefined
      ? {}
      : { persistentGrants: status.user.persistentGrants.state }),
  }
}

export interface SrtPlatformReadiness {
  ok: boolean
  /** 只有 Windows 未 provisioning 时使用；doctor 据此映射错误码 */
  code?: 'SANDBOX_NOT_PROVISIONED'
  detail: string
}

export interface SrtPlatformInput {
  platform: NodeJS.Platform
  windows?: SrtWindowsStatus
  /** Linux：/proc/sys/kernel/apparmor_restrict_unprivileged_userns 的内容 */
  apparmorUserns?: string
}

const APPARMOR_USERNS_PATH = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/**
 * 纯函数：把平台状态翻成 doctor 能直接展示的结论。
 *
 * 抽出来是为了在没有 Windows / Linux 的机器上也能测三平台分支。
 */
export function evaluateSrtPlatform(input: SrtPlatformInput): SrtPlatformReadiness {
  if (input.platform === 'win32') {
    if (input.windows === undefined) {
      return {
        ok: false,
        code: 'SANDBOX_NOT_PROVISIONED',
        detail: '无法读取 Windows 沙箱状态（srt-win status 无返回）',
      }
    }
    const issues = windowsSandboxIssues(input.windows)
    if (issues.length > 0) {
      return { ok: false, code: 'SANDBOX_NOT_PROVISIONED', detail: issues.join('；') }
    }
    return { ok: true, detail: `srt-sandbox 已安装；WFP ${input.windows.wfpState}` }
  }

  if (input.platform === 'linux') {
    const raw = input.apparmorUserns?.trim()
    if (raw === '1') {
      return {
        ok: false,
        detail:
          'kernel.apparmor_restrict_unprivileged_userns=1：bwrap 无法创建带 capability 的 user namespace。运行 sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      }
    }
    return {
      ok: true,
      detail: raw === '0' ? 'apparmor userns 限制已关闭' : '未检测到 apparmor userns 限制',
    }
  }

  if (input.platform === 'darwin') {
    return { ok: true, detail: 'macOS 使用 sandbox-exec，无需额外平台检查' }
  }

  return { ok: false, detail: `不支持的平台：${input.platform}` }
}

/**
 * 平台级沙箱自检（doctor / 启动前置）。
 *
 * 与 `probeSandbox()` 的分工：后者查 CLI 是否存在（srt / bwrap / socat / rg），
 * 这里查「存在但没装好」——Windows 的账户/WFP、Linux 的 apparmor userns。
 */
export async function probeSrtPlatform(
  platform: NodeJS.Platform = process.platform,
): Promise<SrtPlatformReadiness> {
  if (platform === 'win32') {
    try {
      return evaluateSrtPlatform({
        platform,
        windows: normalizeWindowsStatus(checkWindowsSandboxStatus()),
      })
    } catch (error) {
      return {
        ok: false,
        code: 'SANDBOX_NOT_PROVISIONED',
        detail: `Windows 沙箱状态检查失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  if (platform === 'linux') {
    let apparmorUserns: string | undefined
    try {
      apparmorUserns = await readFile(APPARMOR_USERNS_PATH, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          ok: false,
          detail: `无法读取 ${APPARMOR_USERNS_PATH}：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return evaluateSrtPlatform({
      platform,
      ...(apparmorUserns === undefined ? {} : { apparmorUserns }),
    })
  }

  return evaluateSrtPlatform({ platform })
}

export function createSrtDriver(platform: NodeJS.Platform = process.platform): SrtDriver {
  return {
    isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),

    checkDependencies: (): SrtDependencyReport => {
      const result = SandboxManager.checkDependencies()
      return { errors: [...result.errors], warnings: [...result.warnings] }
    },

    ...(platform === 'win32'
      ? { checkWindowsStatus: () => normalizeWindowsStatus(checkWindowsSandboxStatus()) }
      : {}),

    initialize: async (settings: SrtSettings): Promise<void> => {
      await SandboxManager.initialize(settings as SandboxRuntimeConfig)
    },

    wrapArgv: async (command, settings, cwd, options) => {
      const result = await SandboxManager.wrapWithSandboxArgv(
        command,
        undefined,
        settings as Partial<SandboxRuntimeConfig>,
        undefined,
        cwd,
        options,
      )
      return { argv: result.argv, env: result.env }
    },

    registerCommandNetworkLists: (commandId, lists) => {
      SandboxManager.registerCommandNetworkLists(commandId, lists)
    },

    unregisterCommandNetworkLists: (commandId) => {
      SandboxManager.unregisterCommandNetworkLists(commandId)
    },

    reset: async (): Promise<void> => {
      await SandboxManager.reset()
    },
  }
}

export interface CreateSrtProviderOptions {
  platform?: NodeJS.Platform
}

/** 默认入口：真实 srt + 当前平台 */
export function createSrtProvider(options: CreateSrtProviderOptions = {}): SrtProvider {
  const platform = options.platform ?? process.platform
  return new SrtProvider(createSrtDriver(platform), platform)
}
