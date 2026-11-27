import { connectRemoteAgent, type RemoteAgentClient } from '../adapters/a2a/client'
import { fromTaskState } from '../adapters/a2a/mapping'
import type { MutualTlsMaterial } from '../adapters/a2a/mtls'
import { HubError } from '../shared/errors'
import type { Db } from '../storage/db'
import type { DispatchExecutor, DispatchIntent, DispatchOutcome } from './dispatch/types'
import { findRemoteTaskByIdempotencyKey, rememberRemoteTask } from './remote-task'

/**
 * 出站所需的最小对端信息。
 *
 * token 与 tls 二选一或共存：`tls` 给出时用客户端证书（mTLS），token 只作为兼容。
 * token 只在执行时从配置解析，绝不落库（dispatch payload 与 DB 都不存）。
 */
export interface PeerEndpoint {
  url: string
  token?: string
  tls?: MutualTlsMaterial
}

export type ResolvePeerEndpoint = (peerId: string) => PeerEndpoint | undefined

export type ConnectRemote = (options: PeerEndpoint) => Promise<RemoteAgentClient>

export interface RemoteDispatchExecutorOptions {
  db: Db
  /** peerId → 端点与 token；未配置即失败关闭（不猜默认值）。 */
  resolvePeer: ResolvePeerEndpoint
  /** 缺省用真实 SDK 客户端；测试注入假实现。 */
  connect?: ConnectRemote
  now?: Date
}

/** 远程派发意图的载荷：只放“派给谁”，其余语义复用 intent 自身字段。 */
export interface RemoteDispatchSpec {
  peerId: string
}

/**
 * `target='remote-a2a'` 的执行器（A3）。
 *
 * **只提交**：发一次 `SendMessage`，把 `remoteTaskId` 记进 `remote_task_refs` 就收尾。
 * 之后的状态一律由对账轮询（`listRemoteTasksNeedingPoll` + `GetTask`）推进——
 * 远程执行可能以分钟计，绝不能在派发这一步同步等它，那正是 ADR 0027 否掉的形态。
 *
 * 三条不变量：
 * 1. **重放不重发**：同一 `idempotencyKey` 已有 ref 时直接当成功，不再发请求。
 * 2. **不发下一决策点**：提交成功不代表有结果，决策点等对账看到远端终态再产生。
 * 3. **失败不自动重试**：发送抛错时请求可能已经到达远端（“未知”），
 *    按 PRD §7.6.4 第 6 条不盲目重发，标失败交对账/人工。
 */
export function createRemoteDispatchExecutor(
  options: RemoteDispatchExecutorOptions,
): DispatchExecutor {
  const connect = options.connect ?? connectRemoteAgent

  return async (intent: DispatchIntent): Promise<DispatchOutcome> => {
    if (intent.target !== 'remote-a2a') {
      throw new HubError('CONFIG_INVALID', '远程执行器只处理 remote-a2a 意图', {
        dispatchId: intent.id,
        target: intent.target,
      })
    }

    /* 1) 幂等：同一键早已派出过，绝不发第二次。 */
    if (findRemoteTaskByIdempotencyKey(options.db, intent.idempotencyKey) !== undefined) {
      return { ok: true }
    }

    const spec = parseRemoteSpec(intent.payload)
    const endpoint = options.resolvePeer(spec.peerId)
    if (endpoint === undefined) {
      return { ok: false, error: `未配置的 peer：${spec.peerId}` }
    }

    const messageId = deriveMessageId(intent.idempotencyKey)
    let sent: Awaited<ReturnType<RemoteAgentClient['send']>>
    try {
      const client = await connect(endpoint)
      sent = await client.send({ text: intent.objective, messageId })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `远端派发失败：${detail}` }
    }

    rememberRemoteTask(options.db, {
      goalId: intent.goalId,
      peerId: spec.peerId,
      idempotencyKey: intent.idempotencyKey,
      remoteTaskId: sent.taskId,
      contextId: sent.contextId,
      messageId,
      observedState: fromTaskState(sent.state),
      ...(options.now === undefined ? {} : { now: options.now }),
    })

    return { ok: true }
  }
}

/**
 * `Message.messageId` 是 A2A 的协议级去重抓手（PRD §4.4）。
 * 由幂等键确定性派生，重试时对端看到的仍是同一个 messageId，能按规范去重。
 */
export function deriveMessageId(idempotencyKey: string): string {
  if (idempotencyKey === '') {
    throw new HubError('CONFIG_INVALID', 'deriveMessageId 需要非空 idempotencyKey')
  }
  return `msg-${idempotencyKey}`
}

/** 载荷是 Runtime 自己写进库的，这里只做形状校验，不接受外部伪造。 */
export function parseRemoteSpec(payload: unknown): RemoteDispatchSpec {
  if (typeof payload !== 'object' || payload === null) {
    throw new HubError('CONFIG_INVALID', '远程派发意图缺少 payload')
  }
  const peerId = (payload as Record<string, unknown>)['peerId']
  if (typeof peerId !== 'string' || peerId === '') {
    throw new HubError('CONFIG_INVALID', '远程派发意图 payload.peerId 无效')
  }
  return { peerId }
}
