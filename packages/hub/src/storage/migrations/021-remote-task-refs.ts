import type { Migration } from './001-init'

/**
 * 迁移 021：远程委托的关联与对账（PLAN-A2A §4.1.1 冻结的字段）。
 *
 * 关键不变量：
 * - `idempotency_key` UNIQUE：重放只能命中同一行，不可能发第二次委托。
 * - `(peer_id, remote_task_id)` UNIQUE：同一远端任务只对应一条本地关联。
 * - `local_execution_id` 暂可空（远程派发只提交、不建 Execution），
 *   一旦 A3 接线建了本地 Execution 就回填；UNIQUE 对 NULL 不生效，
 *   所以回填前不会误伤。
 * - `observed_state` 只能来自远端读取，不允许本地推断写入。
 */
export const MIGRATION_021_REMOTE_TASK_REFS: Migration = {
  id: '021-remote-task-refs',
  sql: `
CREATE TABLE IF NOT EXISTS remote_task_refs (
  id                 TEXT PRIMARY KEY,
  goal_id            TEXT NOT NULL,
  local_execution_id TEXT UNIQUE,
  peer_id            TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  remote_task_id     TEXT NOT NULL,
  context_id         TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  observed_state     TEXT NOT NULL,
  event_cursor       TEXT,
  created_at         TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_refs_remote
  ON remote_task_refs (peer_id, remote_task_id);
CREATE INDEX IF NOT EXISTS idx_remote_refs_goal ON remote_task_refs (goal_id);
CREATE INDEX IF NOT EXISTS idx_remote_refs_state ON remote_task_refs (observed_state, last_seen_at);
`,
}
