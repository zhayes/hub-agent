import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HubError, isErrnoWithCode } from '../../shared/errors'

/**
 * Hub 自己的 Pi profile（`<hubDir>/pi-agent`）读写。
 *
 * 为什么不用 hub 的 config.toml：Pi 的模型/认证契约已经存在（models.json +
 * settings.json），照抄它的格式，用户填的字段 Pi 真的会读；改写 config.toml
 * 还会丢用户注释。见 docs/ARCHITECTURE.md §5.4。
 */

export const MODEL_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export type ModelApi = (typeof MODEL_APIS)[number]

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

const MODELS_SCHEMA = 'https://pi.dev/schemas/models.schema.json'
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const MODEL_ID_PATTERN = /^[^\s]{1,200}$/
const API_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

type JsonObject = Record<string, unknown>

/** 写入的 key 从哪来：字面量 / `$ENV` / `!command`。 */
export type ApiKeyKind = 'literal' | 'env' | 'command' | 'none'

export interface ModelConfigView {
  agentDir: string
  providerId?: string
  providerName?: string
  modelId?: string
  modelName?: string
  baseUrl?: string
  api?: string
  apiKeySet: boolean
  apiKeyKind: ApiKeyKind
  /** 只给字面量 key 的后 4 位；`$ENV` / `!command` 给的是变量名，不是密钥。 */
  apiKeyHint?: string
  contextWindow?: number
  maxTokens?: number
  thinkingLevel?: ThinkingLevel
}

export interface ModelConfigPatch {
  providerId: string
  modelId: string
  /** 传 `''` 表示删除该字段。 */
  providerName?: string
  baseUrl?: string
  api?: string
  /** `undefined` 保留旧 key，`''` 删除，其他按字面量写入。 */
  apiKey?: string
  /** `null` 删除（回到模型默认值）。 */
  contextWindow?: number | null
  maxTokens?: number | null
  thinkingLevel?: ThinkingLevel | null
}

export function readModelConfig(agentDir: string): ModelConfigView {
  const models = readJsonFile(join(agentDir, 'models.json')) ?? {}
  const settings = readJsonFile(join(agentDir, 'settings.json')) ?? {}

  const providers = isObject(models['providers']) ? models['providers'] : {}
  const preferredProvider = asString(settings['defaultProvider'])
  const providerId =
    preferredProvider !== undefined && isObject(providers[preferredProvider])
      ? preferredProvider
      : firstKey(providers)
  const provider = providerId === undefined ? undefined : asObject(providers[providerId])

  const preferredModel = asString(settings['defaultModel'])
  const entries = provider === undefined ? [] : asModelList(provider['models'])
  const entry =
    preferredModel === undefined
      ? entries[0]
      : (entries.find((item) => item['id'] === preferredModel) ?? entries[0])
  const modelId = preferredModel ?? asString(entry?.['id'])

  const overrides = provider === undefined ? undefined : asObject(provider['modelOverrides'])
  const override =
    modelId === undefined || overrides === undefined ? undefined : asObject(overrides[modelId])

  const rawKey = provider === undefined ? undefined : asString(provider['apiKey'])
  const apiKeyKind = classifyKey(rawKey)

  const view: ModelConfigView = {
    agentDir,
    apiKeySet: apiKeyKind !== 'none',
    apiKeyKind,
  }
  if (providerId !== undefined) view.providerId = providerId
  const providerName = provider === undefined ? undefined : asString(provider['name'])
  if (providerName !== undefined) view.providerName = providerName
  if (modelId !== undefined) view.modelId = modelId
  const modelName = asString(entry?.['name'])
  if (modelName !== undefined) view.modelName = modelName
  const baseUrl = provider === undefined ? undefined : asString(provider['baseUrl'])
  if (baseUrl !== undefined) view.baseUrl = baseUrl
  const api = provider === undefined ? undefined : asString(provider['api'])
  if (api !== undefined) view.api = api
  if (apiKeyKind === 'literal' && rawKey !== undefined && rawKey.length >= 8) {
    view.apiKeyHint = `…${rawKey.slice(-4)}`
  }
  const contextWindow =
    asPositiveInt(entry?.['contextWindow']) ?? asPositiveInt(override?.['contextWindow'])
  if (contextWindow !== undefined) view.contextWindow = contextWindow
  const maxTokens = asPositiveInt(entry?.['maxTokens']) ?? asPositiveInt(override?.['maxTokens'])
  if (maxTokens !== undefined) view.maxTokens = maxTokens
  const thinkingLevel = asString(settings['defaultThinkingLevel'])
  if (thinkingLevel !== undefined && isThinkingLevel(thinkingLevel)) {
    view.thinkingLevel = thinkingLevel
  }
  return view
}

/**
 * 合并写入：只动目标 provider 与目标 model，其余 provider / settings 字段原样保留。
 * 两个文件都以 0600 落盘（key 是凭据，不放宽）。
 */
export function writeModelConfig(agentDir: string, patch: ModelConfigPatch): ModelConfigView {
  const providerId = assertProviderId(patch.providerId)
  const modelId = assertModelId(patch.modelId)

  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')
  const models = readJsonFile(modelsPath) ?? {}
  const settings = readJsonFile(settingsPath) ?? {}

  const providers = isObject(models['providers']) ? { ...models['providers'] } : {}
  const existingProvider = asObject(providers[providerId])
  const nextProvider: JsonObject = { ...existingProvider }

  if (patch.providerName !== undefined) {
    const name = patch.providerName.trim()
    if (name === '') delete nextProvider['name']
    else nextProvider['name'] = name
  }
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl.trim() === '') delete nextProvider['baseUrl']
    else nextProvider['baseUrl'] = assertBaseUrl(patch.baseUrl)
  }
  if (patch.api !== undefined) {
    if (patch.api.trim() === '') delete nextProvider['api']
    else nextProvider['api'] = assertApi(patch.api)
  }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === '') delete nextProvider['apiKey']
    else nextProvider['apiKey'] = assertApiKey(patch.apiKey)
  }

  const modelsList = asModelList(existingProvider?.['models']).map((entry) => ({ ...entry }))
  const index = modelsList.findIndex((entry) => entry['id'] === modelId)
  const nextModel: JsonObject = { ...(index === -1 ? {} : modelsList[index]) }
  if (index === -1) nextModel['id'] = modelId
  if (patch.contextWindow !== undefined) {
    if (patch.contextWindow === null) delete nextModel['contextWindow']
    else nextModel['contextWindow'] = assertPositiveInt('contextWindow', patch.contextWindow)
  }
  if (patch.maxTokens !== undefined) {
    if (patch.maxTokens === null) delete nextModel['maxTokens']
    else nextModel['maxTokens'] = assertPositiveInt('maxTokens', patch.maxTokens)
  }
  if (index === -1) modelsList.push(nextModel)
  else modelsList[index] = nextModel
  nextProvider['models'] = modelsList
  providers[providerId] = nextProvider

  const nextModels: JsonObject = {
    $schema: asString(models['$schema']) ?? MODELS_SCHEMA,
    ...models,
    providers,
  }

  const nextSettings: JsonObject = {
    ...settings,
    defaultProvider: providerId,
    defaultModel: modelId,
  }
  if (patch.thinkingLevel === null) delete nextSettings['defaultThinkingLevel']
  else if (patch.thinkingLevel !== undefined) {
    nextSettings['defaultThinkingLevel'] = assertThinkingLevel(patch.thinkingLevel)
  }

  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(modelsPath, nextModels)
  writeJsonAtomic(settingsPath, nextSettings)
  return readModelConfig(agentDir)
}

/** HTTP 边界用：把不可信 JSON 收窄成 patch，非法即 CONFIG_INVALID。 */
export function parseModelPatch(value: unknown): ModelConfigPatch {
  if (!isObject(value)) throw invalid('请求体必须是 JSON 对象')
  const patch: ModelConfigPatch = {
    providerId: assertProviderId(requireString(value, 'providerId')),
    modelId: assertModelId(requireString(value, 'modelId')),
  }
  if (value['providerName'] !== undefined) {
    patch.providerName = requireString(value, 'providerName')
  }
  if (value['baseUrl'] !== undefined) {
    const baseUrl = requireString(value, 'baseUrl')
    patch.baseUrl = baseUrl.trim() === '' ? '' : assertBaseUrl(baseUrl)
  }
  if (value['api'] !== undefined) {
    const api = requireString(value, 'api')
    patch.api = api.trim() === '' ? '' : assertApi(api)
  }
  if (value['apiKey'] !== undefined) {
    const apiKey = requireString(value, 'apiKey')
    patch.apiKey = apiKey === '' ? '' : assertApiKey(apiKey)
  }
  if (value['contextWindow'] !== undefined) {
    patch.contextWindow = nullablePositiveInt(value['contextWindow'], 'contextWindow')
  }
  if (value['maxTokens'] !== undefined) {
    patch.maxTokens = nullablePositiveInt(value['maxTokens'], 'maxTokens')
  }
  if (value['thinkingLevel'] !== undefined) {
    patch.thinkingLevel =
      value['thinkingLevel'] === null ? null : assertThinkingLevel(value['thinkingLevel'])
  }
  return patch
}

/* ---------- 校验 ---------- */

function invalid(message: string): HubError {
  return new HubError('CONFIG_INVALID', message)
}

function assertProviderId(value: string): string {
  const id = value.trim()
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw invalid('providerId 只能用 1–32 位小写字母、数字或连字符，且以字母或数字开头')
  }
  return id
}

function assertModelId(value: string): string {
  const id = value.trim()
  if (!MODEL_ID_PATTERN.test(id)) throw invalid('modelId 不能为空，且不能包含空白字符')
  return id
}

function assertBaseUrl(value: string): string {
  const raw = value.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('baseUrl 必须是合法的 http(s) 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('baseUrl 只支持 http 或 https')
  }
  return raw
}

function assertApi(value: string): string {
  const api = value.trim()
  if (!API_PATTERN.test(api)) throw invalid(`不支持的 api 类型：${api}`)
  return api
}

function assertApiKey(value: string): string {
  if (value.length > 4096) throw invalid('apiKey 过长')
  if (/[\r\n]/.test(value)) throw invalid('apiKey 不能包含换行')
  if (value.trim() === '') throw invalid('apiKey 不能为空白')
  return value
}

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw invalid(`${name} 必须是正整数`)
  return value
}

function nullablePositiveInt(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} 必须是正整数，或 null 表示清除`)
  }
  return value
}

function assertThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== 'string' || !isThinkingLevel(value)) {
    throw invalid(`thinkingLevel 只能是 ${THINKING_LEVELS.join(' | ')}`)
  }
  return value
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

/* ---------- 读写工具 ---------- */

function readJsonFile(path: string): JsonObject | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrnoWithCode(error, 'ENOENT')) return undefined
    throw new HubError('CONFIG_INVALID', `无法读取 ${path}`, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    /* 宁可报错也不覆盖：文件坏了得由用户决定，不能悄悄抹掉他们的配置。 */
    throw new HubError('CONFIG_INVALID', `${path} 不是合法 JSON`, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (!isObject(parsed)) throw new HubError('CONFIG_INVALID', `${path} 必须是 JSON 对象`)
  return parsed
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function classifyKey(value: string | undefined): ApiKeyKind {
  if (value === undefined) return 'none'
  if (value.startsWith('$')) return 'env'
  if (value.startsWith('!')) return 'command'
  return 'literal'
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function asModelList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function firstKey(value: JsonObject): string | undefined {
  return Object.keys(value)[0]
}

function requireString(value: JsonObject, name: string): string {
  const raw = value[name]
  if (typeof raw !== 'string') throw invalid(`${name} 必须是字符串`)
  return raw
}
