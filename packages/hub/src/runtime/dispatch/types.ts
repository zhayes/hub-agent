/** 派发目标。远程 A2A 在 C3 骨架里只占位，真正执行留给接远程的那一步。 */
export type DispatchTarget = 'local-acp' | 'remote-a2a'

export type DispatchStatus = 'pending' | 'claimed' | 'done' | 'failed'

/** 一条「Runtime 该执行什么」的持久化意图。 */
export interface DispatchIntent {
  id: string
  goalId: string
  taskId: string
  subtaskId: string
  target: DispatchTarget
  agentId?: string
  objective: string
  /** 由 Runtime 从已落库事实派生（PRD §13.5.5），不由 Brain 自由生成。 */
  idempotencyKey: string
  /**
   * 显式 executionId。缺省时由 `deriveExecutionId(idempotencyKey)` 派生；
   * 并行路径因为 worktree 租约已固定了 id，会显式传入。
   */
  executionId?: string
  /**
   * 可独立执行所需的规格（worktree / 验收命令 / 网络策略…）。
   * 调度器从库里捞起意图后靠它重建执行上下文；运行时对象（provider）不存这里。
   */
  payload?: unknown
  status: DispatchStatus
  attempts: number
  createdAt: string
  claimedAt?: string
  claimedBy?: string
  /** 本次 claim 的持有凭证；收尾必须回传。 */
  claimToken?: string
  error?: string
}

/**
 * 一次执行的结果。
 *
 * 约定：executor 负责把**执行结果本身**（Execution 状态、证据）写进库；
 * runner 负责在同一个事务里做「意图收尾 + 写下一决策点」。
 * 这两步不能合并成一个大事务——执行是异步 I/O，事务里不能等它。
 * 崩在两者之间时，意图仍是 claimed，由恢复对账补齐（见 PLAN-A2A §5.4）。
 */
export interface DispatchOutcome {
  ok: boolean
  error?: string
  /**
   * 不要收尾，把意图退回 `pending` 等下一轮对账。
   * 用于“发现已有在途执行，不应重复启动”的情况：此时既不能报成功，
   * 也不能把它标失败（真实执行可能还在跑）。退回不提前结束，但 `attempts`
   * 仍累计，所以反复退回终究会被封顶。
   */
  requeue?: boolean
  /** 需要新派发的决策点；与意图收尾同一事务写入，避免「执行完了却没人继续决策」。 */
  nextDecision?: {
    reason: string
    dedupeKey: string
    payload?: unknown
  }
}

export type DispatchExecutor = (intent: DispatchIntent) => Promise<DispatchOutcome>
