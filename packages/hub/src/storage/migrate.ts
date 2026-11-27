import type { Db } from './db'
import { MIGRATION_001_INIT, type Migration } from './migrations/001-init'
import { MIGRATION_002_AGENTS } from './migrations/002-agents'
import { MIGRATION_003_AGENT_PROFILE } from './migrations/003-agent-profile'
import { MIGRATION_004_BRAIN } from './migrations/004-brain'
import { MIGRATION_005_WORKSPACE } from './migrations/005-workspace'
import { MIGRATION_006_CHAT } from './migrations/006-chat'
import { MIGRATION_007_CHAT_APPROVAL } from './migrations/007-chat-approval'
import { MIGRATION_008_CHAT_CLARIFICATION } from './migrations/008-chat-clarification'
import { MIGRATION_009_AGENT_CATALOG } from './migrations/009-agent-catalog'
import { MIGRATION_010_CHAT_AGENT } from './migrations/010-chat-agent'
import { MIGRATION_011_CHAT_ARCHIVE } from './migrations/011-chat-archive'
import { MIGRATION_012_CHAT_STREAM } from './migrations/012-chat-stream'
import { MIGRATION_013_EXECUTION_RESUME } from './migrations/013-execution-resume'
import { MIGRATION_014_CHAT_TOOL_DETAIL } from './migrations/014-chat-tool-detail'
import { MIGRATION_015_DSH_PERMISSION_MODE } from './migrations/015-dsh-permission-mode'
import { MIGRATION_016_DECISION_CLAIM_LEASE } from './migrations/016-decision-claim-lease'
import { MIGRATION_017_DISPATCH_QUEUE } from './migrations/017-dispatch-queue'
import { MIGRATION_018_DISPATCH_PAYLOAD } from './migrations/018-dispatch-payload'
import { MIGRATION_019_DISPATCH_EXECUTION_ID } from './migrations/019-dispatch-execution-id'
import { MIGRATION_020_A2A_TABLES } from './migrations/020-a2a-tables'
import { MIGRATION_021_REMOTE_TASK_REFS } from './migrations/021-remote-task-refs'
import { MIGRATION_022_REMOTE_TASK_CLOSED_AT } from './migrations/022-remote-task-closed-at'
import { MIGRATION_023_A2A_PEER_CERT } from './migrations/023-a2a-peer-cert'
import { MIGRATION_024_REMOTE_EXECUTION_ARTIFACTS } from './migrations/024-remote-execution-artifacts'
import { MIGRATION_025_CHAT_THREAD_WORKSPACE } from './migrations/025-chat-thread-workspace'

/** 迁移按顺序追加；只增不改。 */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_001_INIT,
  MIGRATION_002_AGENTS,
  MIGRATION_003_AGENT_PROFILE,
  MIGRATION_004_BRAIN,
  MIGRATION_005_WORKSPACE,
  MIGRATION_006_CHAT,
  MIGRATION_007_CHAT_APPROVAL,
  MIGRATION_008_CHAT_CLARIFICATION,
  MIGRATION_009_AGENT_CATALOG,
  MIGRATION_010_CHAT_AGENT,
  MIGRATION_011_CHAT_ARCHIVE,
  MIGRATION_012_CHAT_STREAM,
  MIGRATION_013_EXECUTION_RESUME,
  MIGRATION_014_CHAT_TOOL_DETAIL,
  MIGRATION_015_DSH_PERMISSION_MODE,
  MIGRATION_016_DECISION_CLAIM_LEASE,
  MIGRATION_017_DISPATCH_QUEUE,
  MIGRATION_018_DISPATCH_PAYLOAD,
  MIGRATION_019_DISPATCH_EXECUTION_ID,
  MIGRATION_020_A2A_TABLES,
  MIGRATION_021_REMOTE_TASK_REFS,
  MIGRATION_022_REMOTE_TASK_CLOSED_AT,
  MIGRATION_023_A2A_PEER_CERT,
  MIGRATION_024_REMOTE_EXECUTION_ARTIFACTS,
  MIGRATION_025_CHAT_THREAD_WORKSPACE,
]

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

/**
 * 幂等迁移：已应用的 id 跳过。
 * 迁移失败即回滚该条事务，绝不留半迁移状态（ARCHITECTURE §4.2 第 4 步）。
 */
export function migrate(db: Db): MigrateResult {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )

  const has = db.prepare('SELECT 1 AS hit FROM schema_migrations WHERE id = ?')
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')

  const applied: string[] = []
  const skipped: string[] = []

  for (const migration of MIGRATIONS) {
    if (has.get(migration.id) !== undefined) {
      skipped.push(migration.id)
      continue
    }

    db.transaction(() => {
      db.exec(migration.sql)
      insert.run(migration.id, new Date().toISOString())
    })()

    applied.push(migration.id)
  }

  return { applied, skipped }
}

export function pendingMigrations(db: Db): string[] {
  // 尚未迁移的库连 schema_migrations 都不存在：此时“全部待应用”，而不是报错。
  const hasTable = db
    .prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { hit: number } | undefined
  if (hasTable === undefined) {
    return MIGRATIONS.map((migration) => migration.id)
  }

  const has = db.prepare('SELECT 1 AS hit FROM schema_migrations WHERE id = ?')
  return MIGRATIONS.filter((migration) => has.get(migration.id) === undefined).map(
    (migration) => migration.id,
  )
}
