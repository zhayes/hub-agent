import type { Migration } from './001-init'

/**
 * 迁移 022：远端任务关联需要“停止对账”的显式标记。
 *
 * 终态可以由 `observed_state` 判断，但有两种情况需要主动关单：
 * - 远端已无该任务（`TaskNotFound`，PRD §7.6.3：ref 失效，交人工）；
 * - 本地已放弃该委托（取消/超预算）。
 *
 * 没有 `closed_at` 时这两种会在一轮轮轮询里无限重试。关单不等于“成功”，
 * 只是“不再对账”，结论仍以 `observed_state` 与本地验收为准。
 */
export const MIGRATION_022_REMOTE_TASK_CLOSED_AT: Migration = {
  id: '022-remote-task-closed-at',
  sql: `
ALTER TABLE remote_task_refs ADD COLUMN closed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_remote_refs_open ON remote_task_refs (closed_at, last_seen_at);
`,
}
