import type { Migration } from './001-init'

/** 迁移 008：Chat clarification 消息关联 clarificationId。 */
export const MIGRATION_008_CHAT_CLARIFICATION: Migration = {
  id: '008-chat-clarification',
  sql: `ALTER TABLE chat_messages ADD COLUMN clarification_id TEXT;`,
}
