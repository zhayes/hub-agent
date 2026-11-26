import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 内置 Agent 目录（ADR 0021）。
 *
 * 目录只回答一个问题：某个 harness 怎么以 ACP 模式启动。
 * 它不参与协议解析、不做版本判断、不安装任何东西。
 */

export type DetectRule =
  | { kind: 'which'; name: string }
  | { kind: 'path'; paths: readonly string[] }
  | { kind: 'bundle'; paths: readonly string[]; entry?: string; cli?: string; virtualCli?: boolean }

export interface CatalogVariant {
  id: string
  label?: string
  os?: readonly NodeJS.Platform[]
  detect: DetectRule
  requires?: readonly DetectRule[]
  /** 启动命令模板；`<entry>` / `<cli>` 由检测结果替换 */
  command: string
  allowedWrite?: readonly string[]
  /** 因为缺依赖而不可接入时展示的原因 */
  requiresNote?: string
}

export interface CatalogEntry {
  id: string
  label: string
  name: string
  notes?: string
  variants: readonly CatalogVariant[]
}

export interface Catalog {
  version: number
  generatedAt?: string
  entries: readonly CatalogEntry[]
}

export interface CatalogProblem {
  entryId: string
  message: string
}

export interface ParsedCatalog {
  catalog: Catalog
  problems: CatalogProblem[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length === value.length ? items : undefined
}

function platformArray(value: unknown): NodeJS.Platform[] | undefined {
  if (!Array.isArray(value)) return undefined
  const allowed: NodeJS.Platform[] = ['darwin', 'linux', 'win32']
  const items: NodeJS.Platform[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item as NodeJS.Platform)) return undefined
    items.push(item as NodeJS.Platform)
  }
  return items
}

function parseDetect(value: unknown): DetectRule | undefined {
  if (!isRecord(value)) return undefined
  const kind = value['kind']
  if (kind === 'which') {
    const name = stringField(value['name'])
    return name === undefined ? undefined : { kind: 'which', name }
  }
  if (kind === 'path') {
    const paths = stringArray(value['paths'])
    return paths === undefined ? undefined : { kind: 'path', paths }
  }
  if (kind === 'bundle') {
    const paths = stringArray(value['paths'])
    if (paths === undefined) return undefined
    const entry = stringField(value['entry'])
    const cli = stringField(value['cli'])
    const virtualCli = value['virtualCli'] === true
    return {
      kind: 'bundle',
      paths,
      ...(entry === undefined ? {} : { entry }),
      ...(cli === undefined ? {} : { cli }),
      ...(virtualCli ? { virtualCli } : {}),
    }
  }
  return undefined
}

function parseVariant(value: unknown): CatalogVariant | string {
  if (!isRecord(value)) return 'variant 不是对象'
  const id = stringField(value['id'])
  if (id === undefined || !ID_PATTERN.test(id)) return `variant id 非法：${String(value['id'])}`
  const label = stringField(value['label']) ?? id
  const detect = parseDetect(value['detect'])
  if (detect === undefined) return `variant ${id} 的 detect 非法`
  const command = stringField(value['command'])
  if (command === undefined) return `variant ${id} 缺少 command`

  if (command.includes('<entry>') && !(detect.kind === 'bundle' && detect.entry !== undefined)) {
    return `variant ${id} 的 command 使用 <entry>，但 detect 没有 entry`
  }
  if (command.includes('<cli>') && !(detect.kind === 'bundle' && detect.cli !== undefined)) {
    return `variant ${id} 的 command 使用 <cli>，但 detect 没有 cli`
  }

  const os = value['os'] === undefined ? undefined : platformArray(value['os'])
  if (value['os'] !== undefined && os === undefined) return `variant ${id} 的 os 非法`

  const requiresRaw = value['requires']
  const requires: DetectRule[] = []
  if (requiresRaw !== undefined) {
    if (!Array.isArray(requiresRaw)) return `variant ${id} 的 requires 非法`
    for (const item of requiresRaw) {
      const rule = parseDetect(item)
      if (rule === undefined) return `variant ${id} 的 requires 规则非法`
      requires.push(rule)
    }
  }

  const allowedWriteRaw = value['allowedWrite']
  const allowedWrite = allowedWriteRaw === undefined ? undefined : stringArray(allowedWriteRaw)
  if (allowedWriteRaw !== undefined && allowedWrite === undefined) {
    return `variant ${id} 的 allowedWrite 非法`
  }

  const requiresNote = stringField(value['requiresNote'])
  return {
    id,
    label,
    ...(os === undefined ? {} : { os }),
    detect,
    ...(requires.length === 0 ? {} : { requires }),
    command,
    ...(allowedWrite === undefined ? {} : { allowedWrite }),
    ...(requiresNote === undefined ? {} : { requiresNote }),
  }
}

/** 纯函数：便于单测；非法条目被丢弃并记录原因，不抛异常。 */
export function parseCatalog(value: unknown): ParsedCatalog {
  const problems: CatalogProblem[] = []
  if (!isRecord(value)) {
    return {
      catalog: { version: 0, entries: [] },
      problems: [{ entryId: '-', message: '目录根不是对象' }],
    }
  }
  const version = typeof value['version'] === 'number' ? value['version'] : 0
  const generatedAt = stringField(value['generatedAt'])
  const rawEntries = Array.isArray(value['entries']) ? value['entries'] : []
  if (!Array.isArray(value['entries'])) {
    problems.push({ entryId: '-', message: 'entries 不是数组' })
  }

  const entries: CatalogEntry[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()

  for (const raw of rawEntries) {
    if (!isRecord(raw)) {
      problems.push({ entryId: '-', message: 'entry 不是对象' })
      continue
    }
    const id = stringField(raw['id'])
    const label = stringField(raw['label'])
    const name = stringField(raw['name'])
    if (id === undefined || !ID_PATTERN.test(id)) {
      problems.push({ entryId: String(raw['id']), message: 'entry id 非法' })
      continue
    }
    if (label === undefined || name === undefined || !AGENT_NAME_PATTERN.test(name)) {
      problems.push({ entryId: id, message: 'label/name 非法' })
      continue
    }
    if (seenIds.has(id) || seenNames.has(name)) {
      problems.push({ entryId: id, message: 'id 或 name 重复' })
      continue
    }

    const rawVariants = Array.isArray(raw['variants']) ? raw['variants'] : []
    if (rawVariants.length === 0) {
      problems.push({ entryId: id, message: '没有 variants' })
      continue
    }

    const variants: CatalogVariant[] = []
    const seenVariants = new Set<string>()
    let broken = false
    for (const rawVariant of rawVariants) {
      const parsed = parseVariant(rawVariant)
      if (typeof parsed === 'string') {
        problems.push({ entryId: id, message: parsed })
        broken = true
        continue
      }
      if (seenVariants.has(parsed.id)) {
        problems.push({ entryId: id, message: `variant 重复：${parsed.id}` })
        continue
      }
      seenVariants.add(parsed.id)
      variants.push(parsed)
    }
    if (broken && variants.length === 0) continue

    seenIds.add(id)
    seenNames.add(name)
    const notes = stringField(raw['notes'])
    entries.push({ id, label, name, ...(notes === undefined ? {} : { notes }), variants })
  }

  return {
    catalog: { version, ...(generatedAt === undefined ? {} : { generatedAt }), entries },
    problems,
  }
}

/** 包内目录：相对本文件解析，不依赖 cwd。 */
export function builtinCatalogPath(): string {
  return fileURLToPath(new URL('../../../catalog/builtin.json', import.meta.url))
}

export function loadBuiltinCatalog(path = builtinCatalogPath()): ParsedCatalog {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return parseCatalog(raw)
}
