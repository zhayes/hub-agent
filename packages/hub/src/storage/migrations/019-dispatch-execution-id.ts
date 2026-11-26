import type { Migration } from './001-init'

/**
 * 迁移 019：派发意图可以显式指定 executionId。
 *
 * 默认仍由 `deriveExecutionId(idempotencyKey)` 确定性派生（ADR 0027 D4）；
 * 但并行路径在创建 worktree 时就已经把 `executionId` 固定进租约，
 * 执行必须沿用同一个 id，否则租约/交付对不上。
 */
export const MIGRATION_019_DISPATCH_EXECUTION_ID: Migration = {
  id: '019-dispatch-execution-id',
  sql: `ALTER TABLE dispatch_queue ADD COLUMN execution_id TEXT;`,
}
