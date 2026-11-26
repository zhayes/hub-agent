import type { Migration } from './001-init'

/**
 * 迁移 015：dsh 自带一层沙箱，套在 HubAgent 的沙箱里会 sandbox_apply 失败。
 * 外层隔离仍由 HubAgent 提供，所以让 dsh 以 danger-full-access 运行内部工具。
 */
export const MIGRATION_015_DSH_PERMISSION_MODE: Migration = {
  id: '015-dsh-permission-mode',
  sql: `
UPDATE agents
SET command = 'DSH_PERMISSION_MODE=danger-full-access ' || command
WHERE catalog_id = 'dsh'
  AND command NOT LIKE '%DSH_PERMISSION_MODE=%';
`,
}
