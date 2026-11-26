import type { Migration } from './001-init'

/**
 * 迁移 013：审批后续跑同一 execution 所需的现场。
 * - worktree：验收命令的 cwd（工作区可能已被回收，续跑前要检查）；
 * - checks：本次验收的检查列表，续跑时原样重放。
 */
export const MIGRATION_013_EXECUTION_RESUME: Migration = {
  id: '013-execution-resume',
  sql: `
CREATE TABLE IF NOT EXISTS execution_resume (
  execution_id  TEXT PRIMARY KEY,
  worktree      TEXT NOT NULL,
  checks_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`,
}
