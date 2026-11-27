import type { Migration } from './001-init'

/**
 * 迁移 025：会话绑定工作区与权限档。
 *
 * 背景：此前 `worktree` 只有服务级一个值（缺省 `process.cwd()`），于是从
 * `/Users/chad/hub-agent` 起的 daemon 会让 Agent 直接在我们的仓库里执行——已经真实发生过。
 *
 * `worktree` 允许为 NULL 是为了兼容历史会话：**NULL 表示不可执行**（需先补选目录），
 * 绝不再回落到 cwd。
 */
export const MIGRATION_025_CHAT_THREAD_WORKSPACE: Migration = {
  id: '025-chat-thread-workspace',
  sql: `
ALTER TABLE chat_threads ADD COLUMN worktree TEXT;
ALTER TABLE chat_threads ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace-write';
`,
}
