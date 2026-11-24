import { readFile } from 'node:fs/promises'
import { parse } from 'smol-toml'
import { z } from 'zod'
import { HubError, isErrnoWithCode } from './errors'

/**
 * 配置 schema 是唯一来源：CLI、HTTP 边界、后续 Brain 输出都复用它。
 * M0 只落地"能被加载、能被校验"，字段随里程碑增补。
 */
/**
 * 配置 schema 是唯一来源：CLI、HTTP 边界、后续 Brain 输出都复用它。
 *
 * 刻意不提供“跳过沙箱”开关（ADR 0002 决策 1 / PRD §6.9.7）：
 * 隔离是否可用由环境决定，不由配置决定。配置里能关掉的限制等于没有。
 */
export const ConfigSchema = z.object({
  server: z
    .object({
      /** 只监听回环地址；端口仅本机可见 */
      port: z.number().int().min(1).max(65535).default(7788),
    })
    .prefault({}),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

export const defaultConfig: Config = ConfigSchema.parse({})

export interface LoadedConfig {
  config: Config
  /** 配置文件是否存在；不存在时使用默认值（不是错误） */
  found: boolean
  path: string
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isErrnoWithCode(error, 'ENOENT')) {
      return { config: defaultConfig, found: false, path }
    }
    throw error
  }

  let doc: unknown
  try {
    doc = parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HubError('CONFIG_INVALID', `TOML 解析失败：${message}`)
  }

  const result = ConfigSchema.safeParse(doc)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new HubError('CONFIG_INVALID', `配置校验失败：${issues}`)
  }

  return { config: result.data, found: true, path }
}

/** 供 doctor 展示：不抛错，只给结论 */
export async function describeConfig(path: string): Promise<{
  ok: boolean
  detail: string
}> {
  try {
    const loaded = await loadConfig(path)
    return {
      ok: true,
      detail: loaded.found ? `已加载 ${path}` : `未找到 ${path}，使用默认值`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: message }
  }
}
