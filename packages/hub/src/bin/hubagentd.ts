#!/usr/bin/env node
import { scanRecovery } from '../runtime/recovery/scan'
import { acquireLock } from '../shared/lock'
import { dbPath, hubDir, lockPath } from '../shared/paths'
import { openDatabase } from '../storage/db'
import { migrate } from '../storage/migrate'

/**
 * M0 的 daemon 只验证一件事：单实例语义 + 干净退出。
 * HTTP / SSE / SQLite / 调度在 M2 之后接入（见 docs/PLAN.md）。
 *
 *   hubagentd           前台常驻（Ctrl-C / SIGTERM 退出并释放锁）
 *   hubagentd --check   获取锁后立即释放，用于自检
 *
 * 注意：Node 的信号监听**不会**让事件循环保持存活——必须自己拿一个
 * 长期 handle，否则 main() 返回即退出（M2 review 抓到的真实 bug）。
 */
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

async function main(): Promise<void> {
  const dir = hubDir()
  const lock = await acquireLock(dir, lockPath(dir))
  const db = openDatabase(dbPath(dir))
  migrate(db)
  // 启动恢复扫描：非终态 Execution 先收敛为 unknown，交 Brain/用户决策（M8）。
  const recovery = scanRecovery(db)
  db.close()

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      hubDir: dir,
      lock: lock.path,
      recovery,
      note: 'M2 骨架：HTTP/SSE/调度在 M3 之后接入',
    })}\n`,
  )

  if (checkOnly) {
    await lock.release()
    return
  }

  let shuttingDown = false
  // 显式保活：这个 interval 是进程唯一的活动 handle
  const keepAlive = setInterval(() => undefined, 60_000)

  const stop = (): void => {
    clearInterval(keepAlive)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    stop()
    await lock.release()
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: signal })}\n`)
    process.exitCode = 0
  }

  const onSigint = (): void => void shutdown('SIGINT')
  const onSigterm = (): void => void shutdown('SIGTERM')

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
}

main().catch((error: unknown) => {
  const payload =
    typeof error === 'object' && error !== null && 'code' in error
      ? ((error as { toJSON?: () => unknown }).toJSON?.() ?? { message: String(error) })
      : { message: String(error) }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
  process.exitCode = 1
})
