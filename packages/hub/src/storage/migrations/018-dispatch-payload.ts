import type { Migration } from './001-init'

/**
 * 迁移 018：派发意图需要携带“可独立执行”的载荷。
 *
 * 没有这个字段时，意图只能由入队者原线程执行——调度器从库里捞出来也不知道
 * worktree 在哪、验收命令是什么。把执行规格（worktree / checks / 网络策略等）
 * 随意图一起落库，daemon 重启后的补偿派发才有依据。
 *
 * 载荷只存**可序列化**的执行参数；provider 这类运行时对象由调度器注入。
 */
export const MIGRATION_018_DISPATCH_PAYLOAD: Migration = {
  id: '018-dispatch-payload',
  sql: `ALTER TABLE dispatch_queue ADD COLUMN payload TEXT;`,
}
