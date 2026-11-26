import type { Migration } from './001-init'

/**
 * 迁移 017：持久化 dispatch 意图（Dispatcher 骨架）。
 *
 * 解决的问题：执行外部副作用（ACP 会话、未来的 A2A 委托）之前，先把
 * “我要派给谁、派什么”落库。进程崩在派发途中时，库里留有可对账的记录，
 * 而不是只剩一个再也回不来的内存调用栈。
 *
 * 与 `decision_queue` 的区别：
 * - `decision_queue` 是「Brain 该做决定了」，键是 `dedupe_key`；
 * - `dispatch_queue` 是「Runtime 该执行了」，键是 `idempotency_key`（由 Runtime 派生）。
 *
 * claim 语义照搬 decision_queue 的 fencing 模式（`claim_token` + `attempts`）。
 */
export const MIGRATION_017_DISPATCH_QUEUE: Migration = {
  id: '017-dispatch-queue',
  sql: `
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  subtask_id      TEXT NOT NULL,
  target          TEXT NOT NULL,
  agent_id        TEXT,
  objective       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  claimed_at      TEXT,
  claimed_by      TEXT,
  claim_token     TEXT,
  finished_at     TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_pending ON dispatch_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_claimed ON dispatch_queue (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_goal ON dispatch_queue (goal_id, status);
`,
}
