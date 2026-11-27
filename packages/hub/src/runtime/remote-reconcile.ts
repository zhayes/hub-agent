import type { RemoteAgentClient } from '../adapters/a2a/client'
import { connectRemoteAgent } from '../adapters/a2a/client'
import { isTaskNotFound } from '../adapters/a2a/errors'
import { fromTaskState } from '../adapters/a2a/mapping'
import { isTerminalRemoteState } from '../domain/status'
import type { Db } from '../storage/db'
import { enqueueDecisionPoint } from './decision-queue'
import type { RemoteArtifactForm } from './remote-artifact'
import type { ConnectRemote, ResolvePeerEndpoint } from './remote-dispatch'
import { type RemoteSettlementArtifact, settleRemoteExecution } from './remote-execution'
import {
  closeRemoteTask,
  listRemoteTasksNeedingPoll,
  observeRemoteTask,
  type RemoteTaskRef,
} from './remote-task'

/** 默认多久对一次账；太小会打爆对端，太大会让结果迟到。 */
export const DEFAULT_RECONCILE_STALE_MS = 15_000

export interface ReconcileRemotesOptions {
  db: Db
  resolvePeer: ResolvePeerEndpoint
  /** 缺省用真实 SDK 客户端；测试注入假实现。 */
  connect?: ConnectRemote
  now?: Date
  limit?: number
  staleAfterMs?: number
}

export interface ReconcileReport {
  /** 成功刷新、仍在运行的关联。 */
  polled: string[]
  /** 到达远端终态并产出决策点的关联。 */
  terminal: string[]
  /** 远端已无此任务、被关单的关联。 */
  closed: string[]
  failed: Array<{ id: string; error: string }>
}

/**
 * 远端任务对账（A3 §5.2）。
 *
 * 每一轮只做三件事：`GetTask` 读一次 → 写回观测值 → 终态时产出一条决策点。
 *
 * 三条不变量：
 * 1. **只读远端**：`observed_state` 只能来自 `GetTask`，本地不推断（PRD §7.6.4）。
 * 2. **终态才产出决策点**：运行中的远端任务不唤醒 Brain，避免空转回合。
 * 3. **绝不重发**：对账失败只记 `failed`，不重新 `SendMessage`——重发是派发器的事，
 *    且“未知”按 PRD 不重试。
 *
 * 观测写入与决策点在同一事务内提交：崩在中间会整体回滚，下一轮重来，
 * 不会出现“观测到终态却没人继续决策”的半状态。
 */
export async function reconcileRemoteTasks(
  options: ReconcileRemotesOptions,
): Promise<ReconcileReport> {
  const now = options.now ?? new Date()
  const connect = options.connect ?? connectRemoteAgent

  const refs = listRemoteTasksNeedingPoll(options.db, {
    now,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_RECONCILE_STALE_MS,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })

  const report: ReconcileReport = { polled: [], terminal: [], closed: [], failed: [] }
  const clients = new Map<string, RemoteAgentClient>()

  for (const ref of refs) {
    const endpoint = options.resolvePeer(ref.peerId)
    if (endpoint === undefined) {
      report.failed.push({ id: ref.id, error: `未配置的 peer：${ref.peerId}` })
      continue
    }

    let client = clients.get(ref.peerId)
    if (client === undefined) {
      try {
        client = await connect(endpoint)
      } catch (error) {
        report.failed.push({ id: ref.id, error: `连接失败：${messageOf(error)}` })
        continue
      }
      clients.set(ref.peerId, client)
    }

    let task: Awaited<ReturnType<RemoteAgentClient['get']>>
    try {
      task = await client.get(ref.remoteTaskId)
    } catch (error) {
      if (isTaskNotFound(error)) {
        /* 远端已没有这个任务：关单并交人工，不重发（PRD §7.6.3）。 */
        options.db.transaction(() => {
          closeRemoteTask(options.db, { id: ref.id, observedState: 'unknown', now })
          settleRemoteExecution(options.db, { ref, observed: 'unknown', now })
          enqueueDecisionPoint(options.db, {
            goalId: ref.goalId,
            reason: 'remote_task_lost',
            dedupeKey: `remote:${ref.id}:lost`,
            payload: refPayload(ref, 'unknown'),
          })
        })()
        report.closed.push(ref.id)
        continue
      }
      report.failed.push({ id: ref.id, error: messageOf(error) })
      continue
    }

    const observed = fromTaskState(task.status?.state ?? 0)
    const cursor = task.status?.timestamp
    const artifacts = settlementArtifactsOf(task)

    if (isTerminalRemoteState(observed)) {
      try {
        options.db.transaction(() => {
          observeRemoteTask(options.db, {
            id: ref.id,
            observedState: observed,
            ...(cursor === undefined ? {} : { eventCursor: cursor }),
            now,
          })
          /* 先落本地 Execution（含交付物与验收），再关单。全在同一个事务里：
             崩在中间整体回滚，不会出现“远端终态但本地没结果”的半状态。 */
          settleRemoteExecution(options.db, {
            ref,
            observed,
            artifacts,
            now,
          })
          closeRemoteTask(options.db, { id: ref.id, now })
          enqueueDecisionPoint(options.db, {
            goalId: ref.goalId,
            reason: 'remote_task_terminal',
            dedupeKey: `remote:${ref.id}:terminal`,
            payload: refPayload(ref, observed),
          })
        })()
        report.terminal.push(ref.id)
      } catch (error) {
        /* 单条脏数据不能卡死整轮对账；下轮重试（事务已回滚）。 */
        report.failed.push({ id: ref.id, error: messageOf(error) })
      }
      continue
    }

    try {
      options.db.transaction(() => {
        observeRemoteTask(options.db, {
          id: ref.id,
          observedState: observed,
          ...(cursor === undefined ? {} : { eventCursor: cursor }),
          now,
        })
        /* 运行中/等待输入等中间态也要落到本地 Execution（PRD §7.6.1）。 */
        settleRemoteExecution(options.db, { ref, observed, now })
      })()
      report.polled.push(ref.id)
    } catch (error) {
      report.failed.push({ id: ref.id, error: messageOf(error) })
    }
  }

  return report
}

/**
 * A2A `Task.artifacts` → 本地 manifest 输入。
 *
 * 只在 metadata 显式声明 `form` 时采信；否则按是否含 diff 推断，**不猜测**签者与 hash。
 */
function settlementArtifactsOf(task: {
  artifacts?: readonly unknown[]
}): RemoteSettlementArtifact[] {
  const artifacts = task.artifacts ?? []
  return artifacts.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return []
    const record = raw as {
      artifactId?: unknown
      metadata?: unknown
      parts?: unknown
    }
    const artifactId = typeof record.artifactId === 'string' ? record.artifactId : undefined
    if (artifactId === undefined || artifactId === '') return []

    const declared = formOf(record.metadata)
    const parts = Array.isArray(record.parts) ? record.parts : []
    const texts = parts
      .map((part) => {
        const content = (part as { content?: { $case?: string; value?: unknown } } | null)?.content
        return content?.$case === 'text' && typeof content.value === 'string' ? content.value : ''
      })
      .filter((text) => text !== '')

    const looksLikePatch = texts.some(
      (text) => text.startsWith('diff --git') || text.includes('\n--- '),
    )
    const form = declared ?? (looksLikePatch ? 'patch' : 'analysis')
    return [{ artifactId, form }]
  })
}

function formOf(metadata: unknown): RemoteArtifactForm | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const form = (metadata as Record<string, unknown>)['form']
  return form === 'patch' || form === 'commit' || form === 'bundle' || form === 'analysis'
    ? form
    : undefined
}

function refPayload(ref: RemoteTaskRef, observedState: string): Record<string, unknown> {
  return {
    remoteTaskId: ref.remoteTaskId,
    peerId: ref.peerId,
    contextId: ref.contextId,
    observedState,
    ...(ref.localExecutionId === undefined ? {} : { localExecutionId: ref.localExecutionId }),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
