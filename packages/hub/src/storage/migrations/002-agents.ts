import type { Migration } from './001-init'

/**
 * 迁移 002：本地 Agent Registry。
 *
 * agents 是配置/注册表，不是事件派生的业务聚合；删除一条 Agent 不会影响
 * 已产生的 Execution（executions.agent_id 保留历史值）。
 */
export const MIGRATION_002_AGENTS: Migration = {
  id: '002-agents',
  sql: `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  command       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'discovered',
  capabilities  TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);
`,
}
