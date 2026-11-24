/**
 * 迁移 001：初始 schema。
 *
 * 设计取舍（与 ARCHITECTURE §11.4 的差异，已记录）：
 * 实体表（goals / tasks / subtasks / executions …）**就是投影表**，
 * 不再额外建 task_view / subtask_view / execution_view。
 * 理由：同一份数据两份命名只会带来同步风险；读路径直接查实体表即可。
 */
export interface Migration {
  id: string
  sql: string
}

export const MIGRATION_001_INIT: Migration = {
  id: '001-init',
  sql: `
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  intent      TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL REFERENCES goals(id),
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  status               TEXT NOT NULL,
  priority             INTEGER NOT NULL,
  acceptance_criteria  TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks (goal_id, status);

CREATE TABLE IF NOT EXISTS subtasks (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  required               INTEGER NOT NULL,
  dependencies           TEXT NOT NULL,
  required_capabilities  TEXT NOT NULL,
  assigned_agent_id      TEXT,
  priority               INTEGER NOT NULL,
  max_attempts           INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks (task_id, status);
CREATE INDEX IF NOT EXISTS idx_subtasks_ready ON subtasks (status, priority);

CREATE TABLE IF NOT EXISTS executions (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  subtask_id        TEXT NOT NULL REFERENCES subtasks(id),
  agent_id          TEXT NOT NULL,
  session_id        TEXT,
  status            TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  evidence          TEXT,
  failure_category  TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_subtask ON executions (subtask_id, attempt);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status);

CREATE TABLE IF NOT EXISTS verification_runs (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES executions(id),
  checks        TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_execution ON verification_runs (execution_id);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  execution_id   TEXT,
  agent_id       TEXT,
  action         TEXT NOT NULL,
  resource       TEXT NOT NULL,
  risk_level     TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  reason         TEXT NOT NULL,
  decision_mode  TEXT,
  policy_id      TEXT,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS delegation_contracts (
  id               TEXT PRIMARY KEY,
  subtask_id       TEXT NOT NULL REFERENCES subtasks(id),
  execution_id     TEXT,
  requirements     TEXT NOT NULL,
  brief            TEXT NOT NULL,
  workspace        TEXT NOT NULL,
  budget           TEXT NOT NULL,
  policy           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  expires_at       TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_queue (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  claimed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_queue_pending ON decision_queue (status, created_at);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  root_path      TEXT NOT NULL UNIQUE,
  vcs            TEXT NOT NULL,
  allowed_paths  TEXT NOT NULL,
  isolation      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_leases (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  execution_id     TEXT NOT NULL,
  mode             TEXT NOT NULL,
  path             TEXT NOT NULL,
  branch           TEXT,
  base_ref         TEXT,
  holder_agent_id  TEXT NOT NULL,
  status           TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  released_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_status ON workspace_leases (status, acquired_at);

CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  goal_id         TEXT,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  trace_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events (aggregate_type, aggregate_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_goal ON events (goal_id, seq);

CREATE TABLE IF NOT EXISTS projection_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`,
}
