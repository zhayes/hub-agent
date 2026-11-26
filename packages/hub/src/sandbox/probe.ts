import { spawnSync } from 'node:child_process'

/**
 * 自检：当前进程能不能再套一层 macOS seatbelt 沙箱。
 * 如果 HubAgent 本身跑在别的沙箱里（例如从 DSH 终端启动），
 * 这里会失败，之后每个 Agent 都会以 sandbox_apply 失败退出。
 */
export function sandboxExecUsable(): { ok: boolean; detail?: string } {
  if (process.platform !== 'darwin') return { ok: true }
  const result = spawnSync(
    '/usr/bin/sandbox-exec',
    ['-p', '(version 1)(allow default)', '/usr/bin/true'],
    {
      timeout: 5_000,
    },
  )
  if (result.status === 0) return { ok: true }
  const detail = `${result.stderr?.toString() ?? ''}${result.error?.message ?? ''}`.trim()
  return { ok: false, ...(detail === '' ? {} : { detail: detail.slice(0, 300) }) }
}
