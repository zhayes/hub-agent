import type { Migration } from './001-init'

/**
 * 迁移 020：A2A 入站侧的两张表。
 *
 * `a2a_peers`：入站 Peer 身份与撤销。只存 token 的 **sha256**，不存明文；
 * 撤销在本地生效，这是 ADR 0026 的要求（撤销不依赖对端配合）。
 *
 * `a2a_tasks`：A2A Task 的投影（SDK `TaskStore` 的后端）。
 * 它是**对外视图**，不是本地真相——本地真相仍是 events + projections。
 * 保存整份 Task JSON，与 SDK “按 taskId 覆盖” 的语义一致。
 */
export const MIGRATION_020_A2A_TABLES: Migration = {
  id: '020-a2a-tables',
  sql: `
CREATE TABLE IF NOT EXISTS a2a_peers (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'trusted',
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id         TEXT PRIMARY KEY,
  context_id TEXT,
  state      TEXT NOT NULL,
  task_json  TEXT NOT NULL,
  owner      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_owner ON a2a_tasks (owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks (context_id);
`,
}
