import { homedir } from 'node:os'
import type { SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import type { Db } from '../storage/db'
import { type Catalog, loadBuiltinCatalog } from './agent-discovery/catalog'
import {
  type DetectContext,
  evaluateDetect,
  expandHome,
  renderCommand,
} from './agent-discovery/detect'
import {
  type AuthenticateResult,
  authenticateAgent,
  type ProbeResult,
  probeAgent,
} from './agent-probe'
import {
  type AgentRecord,
  addAgent,
  findAgentByName,
  recordAgentProbe,
  setAgentCatalog,
} from './agent-registry'

/**
 * 接入 = 写注册表 + 绑定目录条目 + 验证连接。
 *
 * 验证失败也保留记录：命令本身通常有效，失败多半是登录/网络/依赖，
 * 删掉等于让用户重新填一遍（ADR 0021）。
 */

export interface AdoptOptions {
  db: Db
  provider: SandboxProvider
  home: string
  catalogId: string
  variantId?: string
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
  initializeTimeoutMs?: number
  /** 目录里 `~` 展开到哪个用户 home；默认 os.homedir()（不是 Hub 运行目录） */
  userHome?: string
  /** 测试注入；生产走内置目录 */
  catalog?: Catalog
}

export interface AdoptResult {
  agent: AgentRecord
  probe: ProbeResult
}

const DEFAULT_ADOPT_INITIALIZE_TIMEOUT_MS = 90_000
const inFlight = new Set<string>()

function detectContext(options: AdoptOptions): DetectContext {
  return {
    platform: options.platform ?? process.platform,
    home: options.userHome ?? homedir(),
    env: options.env ?? process.env,
  }
}

function withProbeLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    return Promise.reject(
      new HubError('ACTION_REJECTED', `正在验证 ${key}，请稍后重试`, { agent: key }),
    )
  }
  inFlight.add(key)
  return run().finally(() => inFlight.delete(key))
}

type ProbeContext = Pick<AdoptOptions, 'db' | 'provider' | 'home' | 'now' | 'initializeTimeoutMs'>

async function probeAndRecord(
  db: Db,
  agent: AgentRecord,
  options: ProbeContext,
): Promise<AdoptResult> {
  const probe = await probeAgent({
    provider: options.provider,
    agent,
    home: options.home,
    initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_ADOPT_INITIALIZE_TIMEOUT_MS,
  })
  recordAgentProbe(db, agent.id, {
    status: probe.status,
    at: (options.now ?? new Date()).toISOString(),
    ...(probe.capabilities === undefined ? {} : { capabilities: probe.capabilities }),
    ...(probe.error === undefined ? {} : { error: `${probe.error.code}: ${probe.error.message}` }),
  })
  const updated = findAgentByName(db, agent.name)
  if (updated === undefined) {
    throw new HubError('DB_UNAVAILABLE', `Agent 写入后读不到：${agent.name}`)
  }
  return { agent: updated, probe }
}

export async function adoptAgent(options: AdoptOptions): Promise<AdoptResult> {
  const catalog = options.catalog ?? loadBuiltinCatalog().catalog
  const entry = catalog.entries.find((item) => item.id === options.catalogId)
  if (entry === undefined) {
    throw new HubError('NOT_FOUND', `目录里没有 ${options.catalogId}`, {
      catalogId: options.catalogId,
    })
  }

  const ctx = detectContext(options)
  const candidates = entry.variants
    .filter((variant) => variant.os === undefined || variant.os.includes(ctx.platform))
    .map((variant) => ({ variant, detected: evaluateDetect(variant.detect, ctx) }))
    .filter((item) => item.detected.ok)

  if (candidates.length === 0) {
    throw new HubError('CONFIG_INVALID', `本机没有找到可接入的 ${entry.label} 入口`, {
      catalogId: entry.id,
    })
  }

  const picked =
    options.variantId === undefined
      ? candidates[0]
      : candidates.find((item) => item.variant.id === options.variantId)
  if (picked === undefined) {
    throw new HubError('CONFIG_INVALID', `目录条目 ${entry.id} 没有变体 ${options.variantId}`, {
      catalogId: entry.id,
      variantId: options.variantId,
    })
  }

  const command = renderCommand(picked.variant.command, {
    ...(picked.detected.entry === undefined ? {} : { entry: picked.detected.entry }),
    ...(picked.detected.cli === undefined ? {} : { cli: picked.detected.cli }),
  })
  if (command === undefined) {
    throw new HubError('CONFIG_INVALID', `无法为 ${entry.label} 渲染启动命令`, {
      catalogId: entry.id,
    })
  }

  const agent = addAgent(options.db, {
    name: entry.name,
    command,
    allowedWrite: (picked.variant.allowedWrite ?? []).map((path) => expandHome(path, ctx.home)),
  })
  setAgentCatalog(options.db, agent.id, {
    catalogId: entry.id,
    catalogVersion: catalog.version,
    variantId: picked.variant.id,
  })

  return withProbeLock(agent.name, () => probeAndRecord(options.db, agent, options))
}

export async function verifyAgent(options: ProbeContext & { name: string }): Promise<AdoptResult> {
  const agent = findAgentByName(options.db, options.name)
  if (agent === undefined) {
    throw new HubError('NO_AGENT_AVAILABLE', `没有名为 ${options.name} 的 Agent`, {
      name: options.name,
    })
  }
  return withProbeLock(agent.name, () => probeAndRecord(options.db, agent, options))
}

/** 触发一次登录流程；成功后状态仍由下一次验证决定（不假装已在线）。 */
export async function loginAgent(
  options: ProbeContext & { name: string; methodId: string },
): Promise<AuthenticateResult> {
  const agent = findAgentByName(options.db, options.name)
  if (agent === undefined) {
    throw new HubError('NO_AGENT_AVAILABLE', `没有名为 ${options.name} 的 Agent`, {
      name: options.name,
    })
  }
  return withProbeLock(agent.name, () =>
    authenticateAgent({
      provider: options.provider,
      agent,
      home: options.home,
      methodId: options.methodId,
      ...(options.initializeTimeoutMs === undefined
        ? {}
        : { initializeTimeoutMs: options.initializeTimeoutMs }),
    }),
  )
}
