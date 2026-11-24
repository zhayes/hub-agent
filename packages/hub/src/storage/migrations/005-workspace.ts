import type { Migration } from './001-init'

/** 迁移 005：工作区租约过期时间。 */
export const MIGRATION_005_WORKSPACE: Migration = {
  id: '005-workspace',
  sql: `
ALTER TABLE workspace_leases ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_leases_project_status ON workspace_leases (project_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON workspace_leases (status, expires_at);
`,
}
