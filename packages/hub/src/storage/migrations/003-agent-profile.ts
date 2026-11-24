import type { Migration } from './001-init'

/**
 * 迁移 003：Agent 的网络/写 profile。
 *
 * 本地受信 Agent 默认 `agent-managed`：不套网络白名单，只保留文件/凭据边界；
 * 高风险或远程 Agent 显式设 `allowlist` / `deny`。
 */
export const MIGRATION_003_AGENT_PROFILE: Migration = {
  id: '003-agent-profile',
  sql: `
ALTER TABLE agents ADD COLUMN network_mode TEXT NOT NULL DEFAULT 'agent-managed';
ALTER TABLE agents ADD COLUMN allowed_domains TEXT;
ALTER TABLE agents ADD COLUMN allowed_write TEXT;
`,
}
