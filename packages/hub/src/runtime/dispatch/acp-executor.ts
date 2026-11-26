import type { ExecutionStatus } from '../../domain/status'
import { isActiveExecution } from '../../domain/status'
import type { Db } from '../../storage/db'
import { deriveExecutionId } from '../recovery/idempotency'
import type { DispatchExecutor, DispatchIntent, DispatchOutcome } from './types'

export interface ExistingExecution {
  executionId: string
  /** undefined 表示契约在、但执行行读不到（投影缺失或尚未落库）。 */
  status?: string
}

export interface AcpDispatchExecutorOptions {
  db: Db
  /**
   * 真正跑一次任务。生产传入 `runAcpWithRetry` 的包装；测试注入假实现。
   * 只要求结构上含有 `ok` / `stopReason`，所以 `RunAcpTaskResult` 可直接使用。
   */
  runTask: (
    intent: DispatchIntent,
    executionId: string,
  ) => Promise<{ ok: boolean; stopReason?: string }>
  /** 查重放；默认查 `delegation_contracts` + `executions`。 */
  lookupExisting?: (idempotencyKey: string) => ExistingExecution | undefined
  /**
   * 终态后要派发的决策点。默认 `subtask:<id>:terminal`；
   * 接线到 Brain 循环时换成与回合一致的 key，避免留下没人领的决策点。
   */
  decisionFor?: (intent: DispatchIntent) => NonNullable<DispatchOutcome['nextDecision']>
}

/**
 * 把派发意图接到 ACP 执行上（ADR 0027 D4）。
 *
 * 三条规则：
 * 1. **先查契约**：同一 `idempotencyKey` 已有执行时，绝不重复启动。
 * 2. **终态即对账**：已有执行已到终态，直接按它的结果收尾，不重跑。
 * 3. **在途则退回**：执行还活着时返回 `requeue`，由 runner 退回 pending，
 *    等下一轮再对账——既不能报成功，也不能判失败。
 */
export function createAcpDispatchExecutor(options: AcpDispatchExecutorOptions): DispatchExecutor {
  const lookup =
    options.lookupExisting ?? ((key: string) => lookupExistingExecution(options.db, key))
  const decisionFor =
    options.decisionFor ??
    ((intent: DispatchIntent) => ({
      reason: 'subtask_terminal',
      dedupeKey: `subtask:${intent.subtaskId}:terminal`,
    }))

  return async (intent: DispatchIntent): Promise<DispatchOutcome> => {
    const existing = lookup(intent.idempotencyKey)

    if (existing !== undefined) {
      if (existing.status === undefined) {
        return {
          ok: false,
          requeue: true,
          error: `契约已存在但执行状态读不到：${existing.executionId}`,
        }
      }
      if (isActiveExecution(existing.status as ExecutionStatus)) {
        return { ok: false, requeue: true, error: `已有在途执行：${existing.executionId}` }
      }

      /* 终态：不重跑，按对账结果收尾。 */
      const ok = existing.status === 'succeeded'
      return {
        ok,
        ...(ok ? {} : { error: `重放对账：执行已是 ${existing.status}` }),
        nextDecision: decisionFor(intent),
      }
    }

    const executionId = intent.executionId ?? deriveExecutionId(intent.idempotencyKey)
    const result = await options.runTask(intent, executionId)
    return {
      ok: result.ok,
      ...(result.ok ? {} : { error: result.stopReason ?? 'failed' }),
      nextDecision: decisionFor(intent),
    }
  }
}

/** 默认查重：契约 → execution 行。契约在但执行读不到时 status 为 undefined。 */
export function lookupExistingExecution(
  db: Db,
  idempotencyKey: string,
): ExistingExecution | undefined {
  const contract = db
    .prepare('SELECT execution_id FROM delegation_contracts WHERE idempotency_key = ?')
    .get(idempotencyKey) as { execution_id: string | null } | undefined
  if (contract === undefined || contract.execution_id === null) return undefined

  const execution = db
    .prepare('SELECT status FROM executions WHERE id = ?')
    .get(contract.execution_id) as { status: string } | undefined

  return {
    executionId: contract.execution_id,
    ...(execution === undefined ? {} : { status: execution.status }),
  }
}
