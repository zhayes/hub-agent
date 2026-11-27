import type { RemoteAgentClient } from '../adapters/a2a/client'
import { connectRemoteAgent } from '../adapters/a2a/client'
import { isTaskNotFound } from '../adapters/a2a/errors'
import { fromTaskState } from '../adapters/a2a/mapping'
import { isTerminalRemoteState } from '../domain/status'
import type { Db } from '../storage/db'
import { enqueueDecisionPoint } from './decision-queue'
import type { ConnectRemote, ResolvePeerEndpoint } from './remote-dispatch'
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

    if (isTerminalRemoteState(observed)) {
      options.db.transaction(() => {
        observeRemoteTask(options.db, {
          id: ref.id,
          observedState: observed,
          ...(cursor === undefined ? {} : { eventCursor: cursor }),
          now,
        })
        /* 终态即停止轮询；结论仍以 observed_state + 本地验收为准。 */
        closeRemoteTask(options.db, { id: ref.id, now })
        enqueueDecisionPoint(options.db, {
          goalId: ref.goalId,
          reason: 'remote_task_terminal',
          dedupeKey: `remote:${ref.id}:terminal`,
          payload: refPayload(ref, observed),
        })
      })()
      report.terminal.push(ref.id)
      continue
    }

    observeRemoteTask(options.db, {
      id: ref.id,
      observedState: observed,
      ...(cursor === undefined ? {} : { eventCursor: cursor }),
      now,
    })
    report.polled.push(ref.id)
  }

  return report
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
