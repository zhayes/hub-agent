import { acquireLock } from '../../shared/lock'
import { dbPath as defaultDbPath, hubDir, lockPath } from '../../shared/paths'
import { openDatabase } from '../../storage/db'
import { migrate } from '../../storage/migrate'
import { appliedSeq, rebuildProjections, verifyProjections } from '../../storage/rebuild'

/**
 * 维护命令：把投影当成"可丢弃的缓存"来处理。
 *
 * 只做确定性操作，不判断业务；失败一律以稳定错误码抛出，由 CLI 统一打印。
 *
 * **必须与 daemon 互斥**：重建是"删投影 → 按事件重写"，如果 daemon 在
 * replay 与写事务之间追加事件，重建会写回旧位点并静默丢掉那一条的投影。
 * 因此这里先抢同一把实例锁（抢不到就 LOCK_HELD，而不是冒险跑）。
 */

export interface MaintenanceOptions {
  /** 重建后与事件重放结果逐条比对 */
  verify: boolean
  /** 覆盖数据库路径（测试与多实例用） */
  dbPath?: string
}

export interface MaintenanceReport {
  ok: boolean
  dbPath: string
  migrations: { applied: string[]; skipped: string[] }
  rebuilt: { events: number; lastAppliedSeq: number }
  verify?: { ok: boolean; mismatches: string[] }
}

export async function runRebuildProjections(
  options: MaintenanceOptions,
): Promise<MaintenanceReport> {
  const dir = hubDir()
  const path = options.dbPath ?? defaultDbPath(dir)

  // 与 daemon 共用同一把锁；lock 文件固定落在 hubDir 下。
  const lock = await acquireLock(dir, lockPath(dir))

  try {
    const db = openDatabase(path)

    try {
      const migrations = migrate(db)
      const rebuilt = rebuildProjections(db)

      const report: MaintenanceReport = {
        ok: true,
        dbPath: path,
        migrations,
        rebuilt,
      }

      if (options.verify) {
        const verified = verifyProjections(db)
        report.verify = verified
        // 位点不同步也算失败：投影内容对但位点落后，下次增量读会重复应用。
        report.ok = verified.ok && appliedSeq(db) === rebuilt.lastAppliedSeq
      }

      return report
    } finally {
      db.close()
    }
  } finally {
    await lock.release()
  }
}

export function formatReport(report: MaintenanceReport): string {
  const lines: string[] = []
  lines.push(`数据库：${report.dbPath}`)
  lines.push(
    report.migrations.applied.length > 0
      ? `迁移：应用 ${report.migrations.applied.join(', ')}`
      : `迁移：已是最新（跳过 ${report.migrations.skipped.join(', ')}）`,
  )
  lines.push(
    `重建：${report.rebuilt.events} 个事件，lastAppliedSeq=${report.rebuilt.lastAppliedSeq}`,
  )

  if (report.verify !== undefined) {
    lines.push(
      report.verify.ok
        ? '校验：投影与事件重放一致'
        : `校验：发现 ${report.verify.mismatches.length} 处差异（${report.verify.mismatches.join(', ')}）`,
    )
  }

  return `${lines.join('\n')}\n`
}
