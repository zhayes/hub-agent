import type { Migration } from './001-init'

/**
 * 迁移 004：Brain 决策队列、DecisionRecord 与 clarify 问答。
 */
export const MIGRATION_004_BRAIN: Migration = {
  id: '004-brain',
  sql: `
ALTER TABLE decision_queue ADD COLUMN state_version INTEGER;
ALTER TABLE decision_queue ADD COLUMN payload TEXT;
ALTER TABLE decision_queue ADD COLUMN claimed_by TEXT;
ALTER TABLE decision_queue ADD COLUMN finished_at TEXT;
ALTER TABLE decision_queue ADD COLUMN error TEXT;

CREATE TABLE IF NOT EXISTS decision_records (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL,
  plan_revision  INTEGER,
  type           TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  inputs         TEXT NOT NULL,
  alternatives   TEXT,
  decided_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_records_goal ON decision_records (goal_id, decided_at);

CREATE TABLE IF NOT EXISTS clarifications (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'clarify',
  execution_id TEXT,
  question     TEXT NOT NULL,
  options      TEXT,
  status       TEXT NOT NULL,
  answer       TEXT,
  answered_by  TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  answered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_clarifications_goal ON clarifications (goal_id, status);
`,
}
