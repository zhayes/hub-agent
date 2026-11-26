import type { Migration } from './001-init'

/** 迁移 010：Chat 消息关联 Agent（授权卡片、执行步骤）。 */
export const MIGRATION_010_CHAT_AGENT: Migration = {
  id: '010-chat-agent',
  sql: `ALTER TABLE chat_messages ADD COLUMN agent_name TEXT;`,
}
