import type { Migration } from './001-init'

/** 迁移 011：Chat thread 归档（归档后不出现在列表，历史仍可访问）。 */
export const MIGRATION_011_CHAT_ARCHIVE: Migration = {
  id: '011-chat-archive',
  sql: `ALTER TABLE chat_threads ADD COLUMN archived_at TEXT;`,
}
