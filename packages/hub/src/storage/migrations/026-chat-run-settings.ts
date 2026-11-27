import type { Migration } from './001-init'

/**
 * 迁移 026：会话级运行设置。
 *
 * 控制台要接管 CLI 的五项能力（ADR 0029 §2.4），这些设置必须能按会话存下来：
 * 验收命令、可用 Agent（扇出范围）、Brain 回合预算、交付方式。
 *
 * 一列 JSON 而不是四个列：这些设置永远是**整份读写**，没有按字段查询的需求；
 * 拆成四列只会让加一个设置就要一次迁移。坏值由 `parseRunSettings` 退到默认值，
 * 所以不需要在库里做约束。
 */
export const MIGRATION_026_CHAT_RUN_SETTINGS: Migration = {
  id: '026-chat-run-settings',
  sql: `
ALTER TABLE chat_threads ADD COLUMN run_settings TEXT;
`,
}
