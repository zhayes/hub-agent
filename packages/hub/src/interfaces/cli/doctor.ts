import { existsSync, rmSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkNodeVersion, probeSandbox, probeTool } from '../../sandbox/detect'
import { loadConfig } from '../../shared/config'
import { isErrnoWithCode } from '../../shared/errors'
import { acquireLock } from '../../shared/lock'
import { configPath, dbPath, hubDir, lockPath } from '../../shared/paths'
import { integrityCheck, openDatabase } from '../../storage/db'
import { migrate, pendingMigrations } from '../../storage/migrate'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  ok: boolean
  version: string
  hubDir: string
  checks: CheckResult[]
  /** 阻塞性问题的 name 列表；非空表示"不能开始干活" */
  blocking: string[]
}

/**
 * M0 的 doctor：只回答"这台机器现在能不能开始跑"。
 * 不写业务数据、不启动服务，全部是可重复的只读/可清理检查。
 *
 * 注意沙箱检查**没有关闭开关**（ADR 0002 / PRD §6.9.7）：
 * 缺依赖就是阻塞项，不允许通过配置降级。
 */
export async function runDoctor(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const dir = hubDir(env)
  const checks: CheckResult[] = []
  const blocking: string[] = []

  // 1. Node 版本
  const node = checkNodeVersion(process.versions.node)
  checks.push({ name: 'node', ok: node.ok, detail: node.detail })
  if (!node.ok) blocking.push('node')

  // 2. 运行目录可写
  const dirCheck = await probeWritableDir(dir)
  checks.push({ name: 'hubDir', ok: dirCheck.ok, detail: dirCheck.detail })
  if (!dirCheck.ok) blocking.push('hubDir')

  // 3. 配置文件
  try {
    const loaded = await loadConfig(configPath(dir))
    checks.push({
      name: 'config',
      ok: true,
      detail: loaded.found ? `已加载 ${loaded.path}` : `未找到 ${loaded.path}，使用默认值`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name: 'config', ok: false, detail: message })
    blocking.push('config')
  }

  // 4. SQLite（可打开 / 结构完整 / 迁移状态）
  const db = probeDatabase(dbPath(dir))
  checks.push({ name: 'db', ok: db.ok, detail: db.detail })
  if (!db.ok) blocking.push('db')

  // 5. 沙箱依赖（fail-closed 的前提，不可通过配置关闭）
  const sandbox = await probeSandbox()
  checks.push({
    name: 'sandbox',
    ok: sandbox.ready,
    detail: sandbox.ready
      ? sandbox.tools
          .filter((tool) => tool.available)
          .map((tool) => `${tool.name} ${tool.version ?? ''}`.trim())
          .join('; ')
      : sandbox.note,
  })
  if (!sandbox.ready) blocking.push('sandbox')

  // 5b. 平台级 provisioning：CLI 存在不等于装好了
  //     （Windows 账户/WFP、Linux apparmor userns）。
  const sandboxPlatform = await probePlatformSandbox()
  checks.push({
    name: 'sandboxPlatform',
    ok: sandboxPlatform.ok,
    detail: sandboxPlatform.detail,
  })
  if (!sandboxPlatform.ok) blocking.push('sandboxPlatform')

  // 5c. 队列健康：不阻塞启动，但要让“有活没跑完”看得见（P0 可见性）
  const queues = probeQueues(dbPath(dir))
  checks.push({ name: 'queues', ok: queues.ok, detail: queues.detail })

  // 6. 单实例锁（可获取 / 已有实例在跑都算正常）
  const lock = await probeLock(dir)
  checks.push({ name: 'lock', ok: lock.ok, detail: lock.detail })
  if (!lock.ok) blocking.push('lock')

  // 7. git（worktree 隔离用）
  const git = await probeTool('git', ['--version'])
  checks.push({
    name: 'git',
    ok: git.available,
    detail: git.version ?? '未安装（worktree 隔离将不可用）',
  })
  if (!git.available) blocking.push('git')

  return {
    ok: blocking.length === 0,
    version,
    hubDir: dir,
    checks,
    blocking,
  }
}

export interface DbProbe {
  ok: boolean
  detail: string
}

/**
 * 队列健康：把“失败/卡住/积压”变成可读的一行。
 * 不参与 blocking：队列有积压说明有活没跑完，不代表这台机器不能启动。
 */
export function probeQueues(path: string): DbProbe {
  if (!existsSync(path)) {
    return { ok: true, detail: '无运行库（尚未启动过）' }
  }
  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(path)
    const scalar = (sql: string): number =>
      (db?.prepare(sql).get() as { n: number } | undefined)?.n ?? 0

    const failedDispatch = scalar(
      "SELECT COUNT(*) AS n FROM dispatch_queue WHERE status = 'failed'",
    )
    const claimedDispatch = scalar(
      "SELECT COUNT(*) AS n FROM dispatch_queue WHERE status = 'claimed'",
    )
    const pendingDispatch = scalar(
      "SELECT COUNT(*) AS n FROM dispatch_queue WHERE status = 'pending'",
    )
    const pendingDecision = scalar(
      "SELECT COUNT(*) AS n FROM decision_queue WHERE status = 'pending'",
    )
    const failedDecision = scalar(
      "SELECT COUNT(*) AS n FROM decision_queue WHERE status = 'failed'",
    )

    const parts = [
      `派发 pending ${pendingDispatch} / claimed ${claimedDispatch} / failed ${failedDispatch}`,
      `决策点 pending ${pendingDecision} / failed ${failedDecision}`,
    ]
    const ok = failedDispatch === 0 && failedDecision === 0
    return {
      ok,
      detail: ok ? parts.join('；') : `${parts.join('；')}（有失败项，用 ha task/logs 查原因）`,
    }
  } catch (error) {
    /* 迁移未应用时表可能不存在：这是信息，不是阻塞项。 */
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, detail: `队列不可读：${message}` }
  } finally {
    db?.close()
  }
}

/**
 * 数据库自检：能开、结构完整、迁移是否待应用。
 *
 * 不存在时创建后立即清理——目的是验证"这个路径能建库"，
 * 而不是替用户把库建好（那是 daemon 启动流程的事）。
 */
export function probeDatabase(path: string): DbProbe {
  if (existsSync(path)) {
    let db: ReturnType<typeof openDatabase> | undefined
    try {
      db = openDatabase(path)
      const check = integrityCheck(db)
      if (check !== 'ok') {
        return { ok: false, detail: `${path} 完整性检查失败：${check}` }
      }
      const pending = pendingMigrations(db)
      return {
        ok: true,
        detail:
          pending.length === 0
            ? `${path} 可打开，quick_check 通过`
            : `${path} 可打开；待应用迁移 ${pending.join(', ')}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, detail: `${path} 不可用：${message}` }
    } finally {
      db?.close()
    }
  }

  try {
    const db = openDatabase(path)
    migrate(db)
    db.close()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `无法在 ${path} 建库：${message}` }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true })
    }
  }

  return { ok: true, detail: `${path} 不存在，已验证可建库并清理` }
}

async function probePlatformSandbox(): Promise<{ ok: boolean; detail: string }> {
  try {
    // 动态 import：即使 srt 包本身缺失，doctor 也要能给出结论而不是直接崩。
    const { probeSrtPlatform } = await import('../../sandbox/srt-driver')
    return await probeSrtPlatform()
  } catch (error) {
    return {
      ok: false,
      detail: `沙箱平台自检不可用：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function probeWritableDir(dir: string): Promise<{ ok: boolean; detail: string }> {
  const probeFile = join(dir, '.doctor-probe')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probeFile, String(Date.now()), 'utf8')
    await unlink(probeFile)
    return { ok: true, detail: `${dir} 可写` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `${dir} 不可写：${message}` }
  }
}

async function probeLock(dir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const handle = await acquireLock(dir, lockPath(dir))
    await handle.release()
    return { ok: true, detail: '可获取实例锁（当前无其他实例）' }
  } catch (error) {
    if (isErrnoWithCode(error, 'LOCK_HELD') || (error as { code?: string })?.code === 'LOCK_HELD') {
      return { ok: true, detail: '已有实例在运行（锁被持有）' }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `锁检查失败：${message}` }
  }
}
