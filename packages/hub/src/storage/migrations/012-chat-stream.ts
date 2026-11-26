import type { Migration } from './001-init'

/**
 * 迁移 012：Chat 消息可原地更新（流式思考/工具状态）。
 * - updated_at：SSE 用时间水位推送 message.update；
 * - stage：区分 thinking / tool / thought / output 等步骤类型，供 UI 选用图标。
 */
export const MIGRATION_012_CHAT_STREAM: Migration = {
  id: '012-chat-stream',
  sql: `
ALTER TABLE chat_messages ADD COLUMN updated_at TEXT;
ALTER TABLE chat_messages ADD COLUMN stage TEXT;
UPDATE chat_messages SET updated_at = created_at WHERE updated_at IS NULL;
`,
}
