import type { Migration } from './001-init'

/**
 * 迁移 009：Agent 接入（ADR 0021）。
 *
 * 目录条目一旦接入就与 agents 行绑定：应用升级换了安装路径时，
 * 靠 catalog_id 重新解析命令，而不是让用户手改。
 */
export const MIGRATION_009_AGENT_CATALOG: Migration = {
  id: '009-agent-catalog',
  sql: `
ALTER TABLE agents ADD COLUMN catalog_id TEXT;
ALTER TABLE agents ADD COLUMN catalog_version INTEGER;
ALTER TABLE agents ADD COLUMN variant_id TEXT;
ALTER TABLE agents ADD COLUMN last_probe_at TEXT;
ALTER TABLE agents ADD COLUMN last_probe_error TEXT;
`,
}
