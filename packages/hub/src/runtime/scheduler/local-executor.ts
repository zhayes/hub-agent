import type { VerificationCheck } from '../../domain/entities'
import type { SandboxNetworkMode, SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import type { Db } from '../../storage/db'
import { runAcpWithRetry } from '../acp-retry'
import { type AgentRecord, listAgents } from '../agent-registry'
import { createAcpDispatchExecutor } from '../dispatch/acp-executor'
import type { DispatchExecutor, DispatchIntent } from '../dispatch/types'

/**
 * 派发意图里携带的可序列化执行规格（写入方是 `runGoalWithBrain`）。
 * provider 这类运行时对象不在里面，由调度器注入。
 */
export interface LocalDispatchSpec {
  worktree: string
  checks?: readonly VerificationCheck[]
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  allowedWrite?: readonly string[]
  transcriptDir?: string
  clientVersion?: string
  promptTimeoutMs?: number
  initializeTimeoutMs?: number
}

export interface LocalAcpExecutorDeps {
  db: Db
  provider: SandboxProvider
  /** 按 id 找 Agent；缺省查注册表。找不到就失败关闭，不猜默认值。 */
  findAgent?: (id: string) => AgentRecord | undefined
}

/**
 * 从库里捞出的意图重建一次 ACP 执行。
 *
 * 这是调度器的默认执行器：`brain-run` 入队时写下的 payload 足以让它脱离原调用栈运行，
 * 所以 daemon 重启后的补偿派发与崩溃对账都能用同一条路径。
 */
export function createLocalAcpExecutor(deps: LocalAcpExecutorDeps): DispatchExecutor {
  const findAgent =
    deps.findAgent ?? ((id: string) => listAgents(deps.db).find((agent) => String(agent.id) === id))

  return createAcpDispatchExecutor({
    db: deps.db,
    runTask: async (intent: DispatchIntent, executionId: string) => {
      const spec = parseDispatchSpec(intent.payload)
      const agent = intent.agentId === undefined ? undefined : findAgent(intent.agentId)
      if (agent === undefined) {
        throw new HubError('NOT_FOUND', '派发意图指定的 Agent 不在注册表中', {
          agentId: intent.agentId ?? null,
          dispatchId: intent.id,
        })
      }
      return runAcpWithRetry({
        db: deps.db,
        provider: deps.provider,
        agent,
        objective: intent.objective,
        worktree: spec.worktree,
        goalId: intent.goalId,
        taskId: intent.taskId,
        subtaskId: intent.subtaskId,
        executionId,
        ...(spec.checks === undefined ? {} : { checks: spec.checks }),
        ...(spec.networkMode === undefined ? {} : { networkMode: spec.networkMode }),
        ...(spec.allowedDomains === undefined ? {} : { allowedDomains: spec.allowedDomains }),
        ...(spec.allowedWrite === undefined ? {} : { allowedWrite: spec.allowedWrite }),
        ...(spec.transcriptDir === undefined ? {} : { transcriptDir: spec.transcriptDir }),
        ...(spec.clientVersion === undefined ? {} : { clientVersion: spec.clientVersion }),
        ...(spec.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: spec.promptTimeoutMs }),
        ...(spec.initializeTimeoutMs === undefined
          ? {}
          : { initializeTimeoutMs: spec.initializeTimeoutMs }),
      })
    },
    /* 调度器独立执行时用基于 subtask 的稳定键；Brain 循环那条路径会传自己的 round 键。 */
    decisionFor: (intent: DispatchIntent) => ({
      reason: 'subtask_terminal',
      dedupeKey: `subtask:${intent.subtaskId}:terminal`,
    }),
  })
}

/**
 * 只做形状校验：payload 是 Runtime 自己写进去的，不是外部输入。
 * 真正站不住的 checks 会在验收阶段失败，不会被静默当成通过。
 */
export function parseDispatchSpec(payload: unknown): LocalDispatchSpec {
  if (typeof payload !== 'object' || payload === null) {
    throw new HubError('CONFIG_INVALID', '派发意图缺少执行规格 payload')
  }
  const record = payload as Record<string, unknown>
  const worktree = record['worktree']
  if (typeof worktree !== 'string' || worktree === '') {
    throw new HubError('CONFIG_INVALID', '派发意图 payload.worktree 无效')
  }

  const asStrings = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : undefined
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const asText = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined

  const checks = Array.isArray(record['checks'])
    ? (record['checks'] as VerificationCheck[])
    : undefined
  const networkMode = asText(record['networkMode']) as SandboxNetworkMode | undefined

  const allowedDomains = asStrings(record['allowedDomains'])
  const allowedWrite = asStrings(record['allowedWrite'])
  const transcriptDir = asText(record['transcriptDir'])
  const clientVersion = asText(record['clientVersion'])
  const promptTimeoutMs = asNumber(record['promptTimeoutMs'])
  const initializeTimeoutMs = asNumber(record['initializeTimeoutMs'])

  return {
    worktree,
    ...(checks === undefined ? {} : { checks }),
    ...(networkMode === undefined ? {} : { networkMode }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(allowedWrite === undefined ? {} : { allowedWrite }),
    ...(transcriptDir === undefined ? {} : { transcriptDir }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
    ...(initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs }),
  }
}
