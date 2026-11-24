import type { Migration } from './001-init'

/** 迁移 007：Chat approval 消息关联 approvalId。 */
export const MIGRATION_007_CHAT_APPROVAL: Migration = {
  id: '007-chat-approval',
  sql: `ALTER TABLE chat_messages ADD COLUMN approval_id TEXT;`,
}
