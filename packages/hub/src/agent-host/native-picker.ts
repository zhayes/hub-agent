import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * 系统原生目录选择框（macOS `choose folder`）。
 *
 * 为什么需要它：浏览器**永远不会**把绝对路径给网页（`webkitdirectory` 只有相对路径，
 * `showDirectoryPicker()` 只给 handle）。而会话工作区必须是**daemon 这台机器上**的真实路径，
 * 所以只能由 daemon 侧弹窗、把用户亲手选的目录回给前端。
 *
 * 为什么它不走沙箱（对本仓库"所有子进程必须经 SandboxProvider"的唯一例外）：
 * 它是 daemon 的**界面交互**，不是 Agent 的执行，也不读写用户项目内容；
 * 而套上 srt 之后 GUI 根本弹不出来。见 AGENTS.md 的例外说明。
 *
 * 安全性：这个模块**不接受任何路径参数**，只能返回用户在系统框里点的目录，
 * 因此它不具备"探测任意目录"的能力（这与 `?path=` 式的浏览接口有本质区别）。
 */

export type PickDirectoryOutcome =
  | { kind: 'picked'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'busy' }

export interface PickDirectoryOptions {
  /** 弹框标题 */
  prompt?: string
  /** 用户操作弹框的最长等待；超时按取消处理 */
  timeoutMs?: number
  platform?: NodeJS.Platform
  /** 测试注入 */
  exec?: ExecFn
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<ExecResult>

const DEFAULT_PROMPT = '选择这个对话的工作区'
const DEFAULT_TIMEOUT_MS = 120_000

/** 同一时刻只允许一个弹框：叠出一堆系统窗口既没法用，也容易误点。 */
let inFlight = false

export const defaultExec: ExecFn = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeout, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

/** `choose folder` 的 AppleScript：返回 POSIX 路径。 */
export function buildChooseFolderArgs(prompt: string = DEFAULT_PROMPT): string[] {
  /* 双引号与反斜杠必须转义，否则 prompt 里的引号会把脚本截断。 */
  const escaped = prompt.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return ['-e', `POSIX path of (choose folder with prompt "${escaped}")`]
}

/** 解析 osascript 的输出；空输出/非绝对路径一律视为未选中。 */
export function parseChooseFolderOutput(stdout: string): string | undefined {
  const path = stdout.trim().replace(/\/+$/, '')
  if (path === '' || !isAbsolute(path)) return undefined
  return path
}

/** 用户取消：osascript 退出码非 0，且 stderr 里带 -128 / User canceled。 */
export function isCancellation(result: ExecResult): boolean {
  if (result.code === 0) return false
  return /-128|user cancel|user cancel?led|cancelled|canceled/i.test(result.stderr)
}

export async function pickDirectory(
  options: PickDirectoryOptions = {},
): Promise<PickDirectoryOutcome> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    /* 其它平台没有统一的系统目录框；让调用方降级为手动输入。 */
    return { kind: 'unsupported' }
  }
  if (inFlight) return { kind: 'busy' }

  inFlight = true
  try {
    const exec = options.exec ?? defaultExec
    const result = await exec('osascript', buildChooseFolderArgs(options.prompt), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    if (isCancellation(result)) return { kind: 'cancelled' }
    if (result.code !== 0) return { kind: 'cancelled' }

    const path = parseChooseFolderOutput(result.stdout)
    if (path === undefined) return { kind: 'cancelled' }
    /* 选完立刻确认它确实是目录：符号链接/竞态都不放过。 */
    try {
      if (!statSync(path).isDirectory()) return { kind: 'cancelled' }
    } catch {
      return { kind: 'cancelled' }
    }
    return { kind: 'picked', path }
  } finally {
    inFlight = false
  }
}

/** 仅供测试重置并发闸门。 */
export function resetPickerState(): void {
  inFlight = false
}
