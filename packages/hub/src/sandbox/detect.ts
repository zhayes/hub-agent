import { type ChildProcess, spawn } from 'node:child_process'

/**
 * 沙箱依赖探测（ARCHITECTURE §12.1 / ADR 0002）。
 *
 * 这是 src 下除 agent-host 之外唯一允许使用 child_process 的目录（R8）。
 * 这里只做"能不能跑"的探测，不承担任何业务判断。
 */
const PROBE_TIMEOUT_MS = 3_000

export interface ToolProbe {
  name: string
  available: boolean
  version?: string
}

export interface SandboxReadiness {
  platform: NodeJS.Platform
  required: string[]
  tools: ToolProbe[]
  missing: string[]
  ready: boolean
  note: string
}

export function probeTool(name: string, args: readonly string[]): Promise<ToolProbe> {
  return new Promise<ToolProbe>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let child: ChildProcess | undefined

    const settle = (probe: ToolProbe): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(probe)
    }

    timer = setTimeout(() => {
      settle({ name, available: false })
      child?.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)

    try {
      child = spawn(name, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      settle({ name, available: false })
      return
    }

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', () => settle({ name, available: false }))
    child.on('close', (code) => {
      const firstLine = output
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
      settle({
        name,
        available: code === 0,
        ...(firstLine === undefined ? {} : { version: firstLine }),
      })
    })
  })
}

/** 纯函数：便于单测，不触碰进程 */
export function evaluateSandboxReadiness(
  tools: readonly ToolProbe[],
  platform: NodeJS.Platform,
): SandboxReadiness {
  const required = platform === 'linux' ? ['srt', 'bwrap', 'socat', 'rg'] : ['srt', 'rg']
  const missing = required.filter((name) => !tools.some((t) => t.name === name && t.available))

  return {
    platform,
    required,
    tools: [...tools],
    missing,
    ready: missing.length === 0,
    note:
      missing.length === 0
        ? '沙箱依赖齐备'
        : `缺少依赖：${missing.join(', ')}。按 V1 设计将拒绝执行任务（fail-closed）`,
  }
}

export async function probeSandbox(
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxReadiness> {
  const spec =
    platform === 'linux'
      ? [
          { name: 'srt', args: ['--version'] },
          { name: 'bwrap', args: ['--version'] },
          { name: 'socat', args: ['-V'] },
          { name: 'rg', args: ['--version'] },
        ]
      : [
          { name: 'srt', args: ['--version'] },
          { name: 'rg', args: ['--version'] },
        ]

  const tools = await Promise.all(spec.map((item) => probeTool(item.name, item.args)))
  return evaluateSandboxReadiness(tools, platform)
}

export interface NodeVersionCheck {
  ok: boolean
  detail: string
}

/** srt 的 engines 要求 Node >= 22.12；我们以此为下限 */
export function checkNodeVersion(current: string, required = '22.12.0'): NodeVersionCheck {
  const parseVersion = (value: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = value
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
    return [major, minor, patch]
  }

  const [curMajor, curMinor, curPatch] = parseVersion(current)
  const [reqMajor, reqMinor, reqPatch] = parseVersion(required)

  const ok =
    curMajor > reqMajor ||
    (curMajor === reqMajor && curMinor > reqMinor) ||
    (curMajor === reqMajor && curMinor === reqMinor && curPatch >= reqPatch)

  return { ok, detail: `${current}（需要 >= ${required}）` }
}
