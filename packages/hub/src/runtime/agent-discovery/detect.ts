import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { DetectRule } from './catalog'

/**
 * 目录条目的静态检测：只看文件系统，**不执行任何候选二进制**。
 * （ADR 0021：扫描必须零副作用；WorkBuddy 的 --version 会下载 60MB。）
 */

export interface DetectContext {
  platform: NodeJS.Platform
  home: string
  env: Readonly<Record<string, string | undefined>>
}

export interface DetectResult {
  ok: boolean
  detail: string
  entry?: string
  cli?: string
}

export function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM'
  return raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0)
}

/** PATH 查找，不 spawn（R8 只允许 agent-host/sandbox 起进程）。 */
export function findInPath(name: string, ctx: DetectContext): string | undefined {
  const pathEnv = ctx.env['PATH'] ?? ''
  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0)
  const candidates =
    ctx.platform === 'win32' && !name.includes('.')
      ? [name, ...windowsExtensions(ctx.env).map((ext) => `${name}${ext}`)]
      : [name]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      if (isExecutableFile(full, ctx.platform)) return full
    }
  }
  return undefined
}

export function evaluateDetect(rule: DetectRule, ctx: DetectContext): DetectResult {
  if (rule.kind === 'which') {
    const found = findInPath(rule.name, ctx)
    return found === undefined
      ? { ok: false, detail: `PATH 中没有 ${rule.name}` }
      : { ok: true, detail: found }
  }

  if (rule.kind === 'path') {
    for (const raw of rule.paths) {
      const path = expandHome(raw, ctx.home)
      if (existsSync(path)) return { ok: true, detail: path }
    }
    return { ok: false, detail: `不存在：${rule.paths.join(' / ')}` }
  }

  for (const raw of rule.paths) {
    const base = expandHome(raw, ctx.home)
    if (!existsSync(base)) continue
    const entry = rule.entry === undefined ? undefined : join(base, rule.entry)
    if (entry !== undefined && !existsSync(entry)) continue
    const cli = rule.cli === undefined ? undefined : join(base, rule.cli)
    if (cli !== undefined && rule.virtualCli !== true && !existsSync(cli)) continue
    return {
      ok: true,
      detail: base,
      ...(entry === undefined ? {} : { entry }),
      ...(cli === undefined ? {} : { cli }),
    }
  }
  return { ok: false, detail: `不存在：${rule.paths.join(' / ')}` }
}

export function renderCommand(
  template: string,
  vars: { entry?: string; cli?: string },
): string | undefined {
  let command = template
  if (command.includes('<entry>')) {
    if (vars.entry === undefined) return undefined
    command = command.replaceAll('<entry>', vars.entry)
  }
  if (command.includes('<cli>')) {
    if (vars.cli === undefined) return undefined
    command = command.replaceAll('<cli>', vars.cli)
  }
  return command
}

/** 检测规则里的路径必须是绝对路径（展开 ~ 之后）；用于目录校验与接入前检查。 */
export function assertAbsoluteAfterExpand(path: string, home: string): boolean {
  return isAbsolute(expandHome(path, home))
}
