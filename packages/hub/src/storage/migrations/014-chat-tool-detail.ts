import type { Migration } from './001-init'

/** 迁移 014：工具调用可展开查看命令/输出。 */
export const MIGRATION_014_CHAT_TOOL_DETAIL: Migration = {
  id: '014-chat-tool-detail',
  sql: `ALTER TABLE chat_messages ADD COLUMN detail TEXT;`,
}
