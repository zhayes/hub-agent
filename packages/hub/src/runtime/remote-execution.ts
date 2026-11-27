import type { ExecutionEvidence, VerificationCheckResult } from '../domain/entities'
import {
  asAgentId,
  asExecutionId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  asVerificationRunId,
  type ExecutionId,
} from '../domain/ids'
import type { ExecutionStatus, RemoteObservedState, SubtaskStatus } from '../domain/status'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { deriveExecutionId } from './recovery/idempotency'
import {
  type RemoteArtifact,
  type RemoteArtifactForm,
  recordRemoteArtifact,
} from './remote-artifact'
import { attachLocalExecution, type RemoteTaskRef } from './remote-task'

/**
 * 远端任务 → 本地 Execution（PRD §7.6.1）。
 *
 * 为什么要建本地 Execution：远端只能证明“它认为做完了”；本机的任务是否完成，
 * 必须由本地执行记录 + 本地验收决定（ADR 0007）。没有本地 Execution，Brain 的
 * 快照里就没有这条子任务的结果，也就无法 accept/finish。
 */

/** 远端执行在本地 Execution 上的 agentId：用 `remote:<peerId>` 表明它不是本机进程。 */
export function remoteAgentId(peerId: string): ReturnType<typeof asAgentId> {
  return asAgentId(`remote:${peerId}`)
}

export interface EnsureRemoteExecutionResult {
  executionId: string
  created: boolean
}

/**
 * 确保远端关联有对应的本地 Execution（幂等、自愈）。
 *
 * `executionId` 由 `idempotencyKey` 确定性派生（ADR 0027 D4）：即使进程崩在
 * “已提交远端、还没建 Execution”之间，下一次对账也会补出同一条记录，不会重复。
 */
export function ensureRemoteExecution(db: Db, ref: RemoteTaskRef): EnsureRemoteExecutionResult {
  if (ref.localExecutionId !== undefined) {
    return { executionId: ref.localExecutionId, created: false }
  }
  if (ref.taskId === undefined || ref.subtaskId === undefined) {
    throw new HubError('CONFIG_INVALID', '远端任务关联缺少 task/subtask，无法建本地 Execution', {
      refId: ref.id,
    })
  }

  const executionId = deriveExecutionId(ref.idempotencyKey)
  const execId = asExecutionId(executionId)
  const taskId = asTaskId(ref.taskId)
  const subtaskId = asSubtaskId(ref.subtaskId)
  const now = asTimestamp(new Date().toISOString())

  /* 关联指向的子任务已不存在（被改写/清理）：不建 Execution，也不报错。
     本地状态机才是权威，不能因为一条远端关联就把不存在的子任务“复活”。 */
  const existing = loadState(db)
  if (existing.subtasks[subtaskId] === undefined || existing.tasks[taskId] === undefined) {
    return { executionId, created: false }
  }

  db.transaction(() => {
    let state = loadState(db)
    if (state.executions[execId] === undefined) {
      state = appendEvent(db, state, {
        type: 'execution.created',
        execution: {
          id: execId,
          taskId,
          subtaskId,
          agentId: remoteAgentId(ref.peerId),
          status: 'created',
          attempt: 1,
          createdAt: now,
        },
      }).state
      state = appendEvent(db, state, {
        type: 'execution.status',
        executionId: execId,
        to: 'starting',
        at: now,
      }).state
      state = appendEvent(db, state, {
        type: 'execution.status',
        executionId: execId,
        to: 'running',
        at: now,
      }).state
    }

    /* 子任务一路 ready → assigned → running，与本地 ACP 路径保持一致。 */
    if (state.subtasks[subtaskId]?.status === 'ready') {
      state = appendEvent(db, state, {
        type: 'subtask.status',
        subtaskId,
        to: 'assigned',
        at: now,
      }).state
    }
    if (state.subtasks[subtaskId]?.status === 'assigned') {
      state = appendEvent(db, state, {
        type: 'subtask.status',
        subtaskId,
        to: 'running',
        at: now,
      }).state
    }

    attachLocalExecution(db, { id: ref.id, localExecutionId: executionId })
  })()

  return { executionId, created: true }
}

/** 远端观测值 → 本地 Execution 状态（PRD §7.6.1 出站列）。 */
export function mapRemoteStateToExecution(observed: RemoteObservedState): ExecutionStatus {
  switch (observed) {
    case 'submitted':
    case 'working':
      return 'running'
    case 'input_required':
      return 'waiting_input'
    case 'auth_required':
      return 'waiting_permission'
    case 'failed':
    case 'rejected':
      return 'failed'
    case 'canceled':
      return 'canceled'
    case 'unknown':
      return 'unknown'
    case 'completed':
      /* completed 要经过本地验收，不能直接映射成 succeeded。 */
      return 'running'
  }
}

export interface RemoteSettlementArtifact {
  artifactId: string
  form: RemoteArtifactForm
  mediaType?: string
  sha256?: string
  size?: number
  baseRef?: string
  baseCommit?: string
  lockDigest?: string
  /** 内联文本内容（patch 的 diff 正文）；只在内存里传给验收器，**不入库**。 */
  content?: string
}

export interface RemoteVerifyResult {
  verdict: 'pass' | 'fail' | 'manual_required'
  /** `verdict='pass'` 时必须给出至少一条通过的可执行检查（Domain 会拒绝空 pass）。 */
  checks?: readonly VerificationCheckResult[]
}

export interface SettleRemoteExecutionInput {
  ref: RemoteTaskRef
  observed: RemoteObservedState
  artifacts?: readonly RemoteSettlementArtifact[]
  /**
   * 本地验收。**不传即视为 `manual_required`**——这是刻意的 fail-closed：
   * 远端 `COMPLETED` 不构成本地成功的依据（PRD §7.7）。
   *
   * 必须同步且只做 DB 写入（调用方在事务里运行）；需要跑命令的验收要另起一步。
   */
  verify?: (input: {
    ref: RemoteTaskRef
    executionId: string
    artifacts: readonly RemoteArtifact[]
  }) => RemoteVerifyResult
  now?: Date
}

/**
 * 把一次远端观测落成本地状态：Execution 状态、交付物 manifest、验收记录。
 *
 * 语义（PRD §7.6.1 / §7.7）：
 * - 运行中：只推进 Execution 状态，不产生验收；
 * - 失败/拒绝/取消/未知：直接收敛 Execution 状态；
 * - 完成：**必须本地验收**。没有验收器 → `manual_required` → Execution `waiting_input`，
 *   交由人工处理，绝不把远端自述当成本地成功。
 */
export function settleRemoteExecution(db: Db, input: SettleRemoteExecutionInput): void {
  const { ref, observed } = input
  /* 关联里没有 task/subtask（历史行或直接调用）：只更新观测值，不建 Execution。
     宁可少一条本地执行记录，也不让对账因为一条旧数据被卡住。 */
  if (
    ref.localExecutionId === undefined &&
    (ref.taskId === undefined || ref.subtaskId === undefined)
  ) {
    return
  }
  const { executionId } = ensureRemoteExecution(db, ref)
  const execId = asExecutionId(executionId)
  const now = asTimestamp((input.now ?? new Date()).toISOString())

  const current = loadState(db)
  const execution = current.executions[execId]
  if (execution === undefined) {
    /* 没有本地 Execution（关联指向的子任务已不存在）：只保留观测值，不强行落状态。 */
    return
  }
  /* 已经收敛的执行不再改写：重复对账必须幂等。 */
  if (isSettled(execution.status)) return

  if (observed !== 'completed') {
    applyStatus(db, execId, ref, mapRemoteStateToExecution(observed), now)
    return
  }

  /* 交付物先入 manifest：它是验收的对象与证据。 */
  const recorded: RemoteArtifact[] = []
  for (const artifact of input.artifacts ?? []) {
    const { artifact: saved } = recordRemoteArtifact(db, {
      remoteTaskRefId: ref.id,
      artifactId: artifact.artifactId,
      form: artifact.form,
      signerPeerId: ref.peerId,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
      ...(artifact.size === undefined ? {} : { size: artifact.size }),
      ...(artifact.baseRef === undefined ? {} : { baseRef: artifact.baseRef }),
      ...(artifact.baseCommit === undefined ? {} : { baseCommit: artifact.baseCommit }),
      ...(artifact.lockDigest === undefined ? {} : { lockDigest: artifact.lockDigest }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
    recorded.push(saved)
  }

  const result = input.verify?.({ ref, executionId, artifacts: recorded }) ?? {
    verdict: 'manual_required' as const,
  }
  /* 空 check 的 pass 会被 Domain 拒绝；这里先降级而不是抛错，避免对账被一条脏数据卡死。 */
  const checks = result.checks ?? []
  const verdict =
    result.verdict === 'pass' && (checks.length === 0 || !checks.every((check) => check.passed))
      ? 'manual_required'
      : result.verdict

  let state = loadState(db)
  state = appendEvent(db, state, {
    type: 'verification.recorded',
    run: {
      id: asVerificationRunId(newId()),
      executionId: execId,
      checks: [...checks],
      verdict,
      decidedBy: 'runtime',
      createdAt: now,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'execution.evidence',
    executionId: execId,
    evidence: remoteEvidence(ref, recorded),
  }).state

  if (verdict === 'pass') {
    appendStatus(db, execId, 'succeeded', now)
    appendSubtaskStatus(db, ref, 'succeeded', now)
    /* 与本地路径一致：验收通过不等于交付完成，Task 保持 running（PRD §6.12.4）。 */
    return
  }
  if (verdict === 'manual_required') {
    appendStatus(db, execId, 'waiting_input', now)
    appendSubtaskStatus(db, ref, 'waiting_input', now)
    appendTaskStatus(db, ref, 'waiting_input', now)
    return
  }
  appendStatus(db, execId, 'failed', now)
  appendSubtaskStatus(db, ref, 'failed', now)
  /* 不直接把 Goal 判失败：留给 Brain 的 reject(replan/retry) 决策。 */
  appendTaskStatus(db, ref, 'failed', now)
}

function isSettled(status: ExecutionStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'timeout' ||
    status === 'unknown'
  )
}

function applyStatus(
  db: Db,
  execId: ExecutionId,
  ref: RemoteTaskRef,
  to: ExecutionStatus,
  now: ReturnType<typeof asTimestamp>,
): void {
  const state = loadState(db)
  const current = state.executions[execId]?.status
  if (current === undefined || current === to) return
  appendStatus(db, execId, to, now)

  if (to === 'waiting_input') appendSubtaskStatus(db, ref, 'waiting_input', now)
  if (to === 'failed' || to === 'canceled') {
    appendSubtaskStatus(db, ref, to === 'canceled' ? 'canceled' : 'failed', now)
  }
}

function appendStatus(
  db: Db,
  execId: ExecutionId,
  to: ExecutionStatus,
  now: ReturnType<typeof asTimestamp>,
): void {
  const state = loadState(db)
  const current = state.executions[execId]?.status
  if (current === undefined || current === to) return
  appendEvent(db, state, { type: 'execution.status', executionId: execId, to, at: now })
}

function appendSubtaskStatus(
  db: Db,
  ref: RemoteTaskRef,
  to: SubtaskStatus,
  now: ReturnType<typeof asTimestamp>,
): void {
  if (ref.subtaskId === undefined) return
  const subtaskId = asSubtaskId(ref.subtaskId)
  const state = loadState(db)
  if (state.subtasks[subtaskId]?.status === to) return
  appendEvent(db, state, { type: 'subtask.status', subtaskId, to, at: now })
}

function appendTaskStatus(
  db: Db,
  ref: RemoteTaskRef,
  to: 'waiting_input' | 'failed',
  now: ReturnType<typeof asTimestamp>,
): void {
  const state = loadState(db)
  const taskId = ref.taskId === undefined ? undefined : asTaskId(ref.taskId)
  if (taskId === undefined || state.tasks[taskId]?.status === to) return
  appendEvent(db, state, { type: 'task.status', taskId, to, at: now })
}

/** 证据：远端任务引用 + 交付物摘要。满足“succeeded 必须有证据”的不变量。 */
function remoteEvidence(
  ref: RemoteTaskRef,
  artifacts: readonly RemoteArtifact[],
): ExecutionEvidence {
  const summary =
    artifacts.length === 0
      ? 'remote: no artifacts'
      : `remote artifacts: ${artifacts
          .map((artifact) => `${artifact.form}:${artifact.artifactId}`)
          .join(', ')}`
  return {
    transcriptRef: `a2a:${ref.peerId}/${ref.remoteTaskId}`,
    diffstat: summary.slice(0, 2000),
    changedFiles: [],
  }
}
