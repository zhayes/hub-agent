import type { Migration } from './001-init'

/**
 * 迁移 024：远端结果落到本地 Execution，并记录交付物 manifest（PRD §7.6.1 / §7.7）。
 *
 * `remote_task_refs` 补 `task_id` / `subtask_id`：有了它们，对账时才能**自愈式**创建
 * 本地 Execution（进程崩在“已提交远端、还没建 Execution”之间也不会丢关联）。
 *
 * `remote_artifacts` 只存交付物的**元数据**（谁产的、什么形态、hash、大小、基线），
 * 不存内容；`verified_at` / `verdict` 是**本地**验收结论，不采信远端自述。
 */
export const MIGRATION_024_REMOTE_EXECUTION_ARTIFACTS: Migration = {
  id: '024-remote-execution-artifacts',
  sql: `
ALTER TABLE remote_task_refs ADD COLUMN task_id TEXT;
ALTER TABLE remote_task_refs ADD COLUMN subtask_id TEXT;

CREATE TABLE IF NOT EXISTS remote_artifacts (
  id                 TEXT PRIMARY KEY,
  remote_task_ref_id TEXT NOT NULL,
  artifact_id        TEXT NOT NULL,
  form               TEXT NOT NULL,
  base_ref           TEXT,
  base_commit        TEXT,
  lock_digest        TEXT,
  sha256             TEXT,
  size               INTEGER,
  media_type         TEXT,
  signer_peer_id     TEXT NOT NULL,
  local_path         TEXT,
  verified_at        TEXT,
  verdict            TEXT,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_artifacts_ref
  ON remote_artifacts (remote_task_ref_id, artifact_id);
`,
}
