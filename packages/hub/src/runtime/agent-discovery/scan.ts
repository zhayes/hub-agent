import type { Db } from '../../storage/db'
import { type AgentRecord, listAgents } from '../agent-registry'
import {
  type Catalog,
  type CatalogEntry,
  type CatalogProblem,
  type CatalogVariant,
  loadBuiltinCatalog,
} from './catalog'
import { type DetectContext, evaluateDetect, expandHome, renderCommand } from './detect'

/**
 * 扫描 = 目录 × 本机文件系统 × 已注册表。
 * 不执行二进制、不写库；结果只在内存里，带时间戳。
 */

export interface ScannedVariant {
  id: string
  label: string
  command: string
  source: string
  allowedWrite: string[]
  missingRequires: string[]
  adoptable: boolean
}

export interface ScannedEntry {
  catalogId: string
  label: string
  name: string
  notes?: string
  variants: ScannedVariant[]
  chosenVariant?: string
  registered: boolean
  agentStatus?: string
}

export interface CatalogScan {
  version: number
  scannedAt: string
  agents: ScannedEntry[]
  problems: CatalogProblem[]
}

export interface ScanOptions {
  platform?: NodeJS.Platform
  home?: string
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
  catalog?: Catalog
}

function describeRequirement(rule: CatalogEntry['variants'][number]['detect']): string {
  if (rule.kind === 'which') return rule.name
  return rule.paths.join(' / ')
}

function scanVariant(variant: CatalogVariant, ctx: DetectContext): ScannedVariant | undefined {
  if (variant.os !== undefined && !variant.os.includes(ctx.platform)) return undefined

  const detected = evaluateDetect(variant.detect, ctx)
  if (!detected.ok) return undefined

  const missingRequires: string[] = []
  for (const rule of variant.requires ?? []) {
    if (!evaluateDetect(rule, ctx).ok) missingRequires.push(describeRequirement(rule))
  }

  const command = renderCommand(variant.command, {
    ...(detected.entry === undefined ? {} : { entry: detected.entry }),
    ...(detected.cli === undefined ? {} : { cli: detected.cli }),
  })
  if (command === undefined) return undefined

  return {
    id: variant.id,
    label: variant.label ?? variant.id,
    command,
    source: detected.detail,
    allowedWrite: (variant.allowedWrite ?? []).map((path) => expandHome(path, ctx.home)),
    missingRequires,
    adoptable: missingRequires.length === 0,
  }
}

export function scanAgents(db: Db, options: ScanOptions = {}): CatalogScan {
  const ctx: DetectContext = {
    platform: options.platform ?? process.platform,
    // biome-ignore lint/suspicious/noExplicitAny: env 只读访问
    home: options.home ?? (process.env['HOME'] as string) ?? '',
    env: options.env ?? process.env,
  }
  const loaded =
    options.catalog === undefined
      ? loadBuiltinCatalog()
      : { catalog: options.catalog, problems: [] }
  const registered = new Map<string, AgentRecord>(
    listAgents(db).map((agent) => [agent.name, agent]),
  )

  const agents: ScannedEntry[] = []
  for (const entry of loaded.catalog.entries) {
    const variants = entry.variants
      .map((variant) => scanVariant(variant, ctx))
      .filter((variant): variant is ScannedVariant => variant !== undefined)
    if (variants.length === 0) continue

    const chosen = variants.find((variant) => variant.adoptable) ?? variants[0]
    const agent = registered.get(entry.name)
    agents.push({
      catalogId: entry.id,
      label: entry.label,
      name: entry.name,
      ...(entry.notes === undefined ? {} : { notes: entry.notes }),
      variants,
      ...(chosen === undefined ? {} : { chosenVariant: chosen.id }),
      registered: agent !== undefined,
      ...(agent === undefined ? {} : { agentStatus: agent.status }),
    })
  }

  return {
    version: loaded.catalog.version,
    scannedAt: (options.now ?? new Date()).toISOString(),
    agents,
    problems: loaded.problems,
  }
}
