import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { createBrainFromEnv } from '../../brain/create-brain'
import type { VerificationCheck } from '../../domain/entities'
import { runAcpTask } from '../../runtime/acp-run'
import { adoptAgent, loginAgent, verifyAgent } from '../../runtime/agent-adopt'
import { scanAgents } from '../../runtime/agent-discovery/scan'
import { addAgent, listAgents, resolveAgent } from '../../runtime/agent-registry'
import { decideApproval, listApprovals } from '../../runtime/approval'
import { runGoalWithBrain } from '../../runtime/brain-run'
import { answerClarification } from '../../runtime/clarify'
import { listDecisions } from '../../runtime/decision-record'
import { cancelTask } from '../../runtime/recovery/cancel'
import { pauseTask, resumeTask } from '../../runtime/recovery/pause'
import { leasesForExecution } from '../../runtime/workspace/lease'
import { runParallelAgents } from '../../runtime/workspace/parallel'
import {
  abortWorktreeSession,
  cleanTaskWorkspace,
  createWorktreeSession,
  finalizeWorktreeSession,
  type WorktreeSession,
} from '../../runtime/workspace/session'
import { createSrtProvider } from '../../sandbox/srt-driver'
import type { SandboxNetworkMode } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import { acquireLock } from '../../shared/lock'
import { dbPath, hubDir, lockPath } from '../../shared/paths'
import { openDatabase } from '../../storage/db'
import { migrate } from '../../storage/migrate'
import { getTaskEvidence } from '../../storage/queries/evidence'
import { listTaskEvents, listTasks } from '../../storage/queries/tasks'
import { startHub } from '../http/server'
import { runDoctor } from './doctor'
import { CLI_EXIT, exitCodeFor, exitCodeForRun } from './exit-codes'
import { formatReport, runRebuildProjections } from './maintenance'

/**
 * CLI 只做"解析参数 + 输出"，不做业务判断。
 * M0 只有 doctor；M2 增加 maintenance；run/task/agent 等在 M4/M9 接入。
 */
export function createCli(version: string): Command {
  const program = new Command()

  program.name('ha').description('HubAgent — 本地优先的多 Agent 编排系统').version(version)

  program
    .command('doctor')
    .description('检查本机是否具备运行条件（Node / 目录 / 配置 / 沙箱 / 锁 / git）')
    .option('--json', '输出机器可读 JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor(version)

      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        for (const check of report.checks) {
          const mark = check.ok ? '✓' : '✗'
          process.stdout.write(`${mark} ${check.name.padEnd(8)} ${check.detail}\n`)
        }
        process.stdout.write(report.ok ? '\n就绪。\n' : `\n阻塞：${report.blocking.join(', ')}\n`)
      }

      process.exitCode = report.ok ? 0 : CLI_EXIT.RUNTIME
    })

  program
    .command('web')
    .description('启动 daemon 并托管 Web 控制台，打印访问地址（Ctrl-C 停止）')
    .option('--port <port>', '监听端口；被占用时自动向后尝试', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--json', '输出机器可读 JSON（启动一行、停止一行）')
    .action(async (options: { port?: number; json?: boolean }) => {
      let handle: Awaited<ReturnType<typeof startHub>> | undefined
      try {
        handle = await startHub({
          version,
          ...(Number.isFinite(options.port) ? { port: options.port } : {}),
        })
        const payload = {
          ok: true,
          url: handle.url,
          port: handle.port,
          home: handle.home,
          tokenPath: handle.tokenPath,
          webBuilt: handle.webBuilt,
          webDist: handle.webDist,
          webBuiltAt: handle.webBuiltAt,
          recovery: handle.recovery,
        }
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(payload)}\n`)
        } else {
          process.stdout.write(`✓ HubAgent 已启动\n`)
          process.stdout.write(`  控制台   ${handle.url}\n`)
          const preferred =
            options.port ?? Number.parseInt(process.env['HUBAGENT_PORT'] ?? '7788', 10)
          if (Number.isFinite(preferred) && handle.port !== preferred) {
            process.stdout.write(`  端口     ${preferred} 被占用，已改用 ${handle.port}\n`)
          }
          if (!handle.webBuilt) {
            process.stdout.write(`  前端资源 ${handle.webDist}（未构建：先跑 pnpm build:web）\n`)
          } else if (handle.webBuiltAt !== undefined) {
            process.stdout.write(
              `  前端资源 ${handle.webDist}（构建于 ${new Date(handle.webBuiltAt).toLocaleString()}）\n`,
            )
          }
          process.stdout.write(`  运行目录 ${handle.home}\n`)
          process.stdout.write('  Ctrl-C 停止\n')
        }

        await new Promise<void>((resolve) => {
          const stop = (): void => {
            process.off('SIGINT', stop)
            process.off('SIGTERM', stop)
            resolve()
          }
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })

        await handle.close()
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, stopped: true })}\n`)
        } else {
          process.stdout.write('✓ 已停止\n')
        }
      } catch (error) {
        await handle?.close().catch(() => undefined)
        writeCliError(error, options.json === true)
      }
    })

  program
    .command('init')
    .description('初始化 HUBAGENT_HOME 与数据库（幂等）')
    .option('--json', '输出机器可读 JSON')
    .action((options: { json?: boolean }) => {
      try {
        const dir = hubDir()
        mkdirSync(dir, { recursive: true })
        const db = openDatabase(dbPath(dir))
        try {
          migrate(db)
        } finally {
          db.close()
        }
        const payload = { ok: true, hubDir: dir, dbPath: dbPath(dir) }
        process.stdout.write(
          options.json === true ? `${JSON.stringify(payload, null, 2)}\n` : `✓ 初始化 ${dir}\n`,
        )
      } catch (error) {
        writeCliError(error, options.json === true)
      }
    })

  program
    .command('config')
    .description('显示当前配置与路径')
    .option('--json', '输出机器可读 JSON')
    .action((options: { json?: boolean }) => {
      const dir = hubDir()
      const payload = {
        version,
        hubDir: dir,
        dbPath: dbPath(dir),
        lockPath: lockPath(dir),
        brainMode: process.env.HUBAGENT_BRAIN_MODE ?? 'pi',
        piAgentDir: process.env.HUBAGENT_PI_AGENT_DIR ?? '(pi default)',
      }
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`)
      } else {
        for (const [key, value] of Object.entries(payload)) {
          process.stdout.write(`${key}: ${value}\n`)
        }
      }
    })

  program
    .command('logs')
    .description('列出 transcript / artifact 目录与文件数')
    .option('--json', '输出机器可读 JSON')
    .action((options: { json?: boolean }) => {
      const dir = hubDir()
      const payload = {
        transcripts: directoryStats(join(dir, 'transcripts')),
        artifacts: directoryStats(join(dir, 'artifacts')),
        worktrees: directoryStats(join(dir, 'worktrees')),
      }
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`)
      } else {
        for (const [name, stats] of Object.entries(payload)) {
          process.stdout.write(`${name}: ${stats.files} files, ${stats.bytes} bytes\n`)
        }
      }
    })

  program
    .command('gc')
    .description('清理过期 transcript / artifact；默认 dry-run')
    .option('--days <n>', '保留天数', (value) => Number.parseInt(value, 10), 30)
    .option('--apply', '实际删除（默认只列出）')
    .option('--json', '输出机器可读 JSON')
    .action((options: { days: number; apply?: boolean; json?: boolean }) => {
      try {
        const cutoff = Date.now() - options.days * 24 * 60 * 60_000
        const candidates = [
          ...listOldFiles(join(hubDir(), 'transcripts'), cutoff),
          ...listOldFiles(join(hubDir(), 'artifacts'), cutoff),
        ]
        if (options.apply === true) {
          for (const file of candidates) rmSync(file, { force: true })
        }
        const payload = {
          ok: true,
          dryRun: options.apply !== true,
          days: options.days,
          candidates,
          removed: options.apply === true ? candidates.length : 0,
        }
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        } else {
          process.stdout.write(
            `${payload.dryRun ? 'dry-run' : 'removed'}: ${candidates.length} files older than ${options.days} days\n`,
          )
          for (const file of candidates) process.stdout.write(`  ${file}\n`)
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      }
    })

  const maintenance = program.command('maintenance').description('维护命令（投影重建与校验）')

  maintenance
    .command('rebuild-projections')
    .description('从事件流重建投影表；--verify 顺带逐条校验一致性')
    .option('--verify', '重建后与事件重放结果逐条比对')
    .option('--db <path>', '覆盖数据库路径（默认取 HUBAGENT_HOME）')
    .option('--json', '输出机器可读 JSON')
    .action(async (options: { verify?: boolean; db?: string; json?: boolean }) => {
      try {
        const report = await runRebuildProjections({
          verify: options.verify === true,
          ...(options.db === undefined ? {} : { dbPath: options.db }),
        })

        process.stdout.write(
          options.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
        )
        process.exitCode = report.ok ? 0 : CLI_EXIT.RUNTIME
      } catch (error) {
        const hubError =
          error instanceof HubError
            ? error
            : new HubError('UNEXPECTED', error instanceof Error ? error.message : String(error))

        process.stderr.write(
          options.json === true
            ? `${JSON.stringify(hubError.toJSON(), null, 2)}\n`
            : `✗ ${hubError.code}: ${hubError.message}\n`,
        )
        process.exitCode = 1
      }
    })

  const agent = program.command('agent').description('本地 ACP Agent 注册表')

  agent
    .command('add')
    .description('注册一个本地 ACP Agent（首次使用需显式添加）')
    .requiredOption('--name <name>', 'Agent 名称（唯一）')
    .requiredOption('--cmd <command>', '启动命令（shell 字符串）')
    .option('--network <mode>', '网络策略：agent-managed（默认）| allowlist | deny')
    .option(
      '--allow-domain <domain>',
      '仅 allowlist 模式：允许访问的域名（可重复）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--allow-write <path>',
      'Agent 自身需要的额外写路径（可重复，绝对路径）',
      (value: string, previous: string[]) => [...previous, resolve(value)],
      [],
    )
    .option('--json', '输出机器可读 JSON')
    .action(
      async (options: {
        name: string
        cmd: string
        network?: string
        allowDomain?: string[]
        allowWrite?: string[]
        json?: boolean
      }) => {
        const dir = hubDir()
        const db = openDatabase(dbPath(dir))
        try {
          migrate(db)
          const allowDomain = options.allowDomain ?? []
          const networkMode = parseNetworkMode(
            options.network,
            allowDomain.length > 0 ? 'allowlist' : 'agent-managed',
          )
          const record = addAgent(db, {
            name: options.name,
            command: options.cmd,
            networkMode,
            allowedDomains: allowDomain,
            allowedWrite: options.allowWrite ?? [],
          })
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, agent: record }, null, 2)}\n`)
          } else {
            process.stdout.write(
              `✓ agent ${record.name} 已注册（${record.id}，network=${record.networkMode}）\n`,
            )
          }
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          db.close()
        }
      },
    )

  agent
    .command('scan')
    .description('扫描本机可接入的 Agent（只读文件系统，不启动进程）')
    .option('--json', '输出机器可读 JSON')
    .action((options: { json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      try {
        migrate(db)
        const scan = scanAgents(db)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...scan }, null, 2)}\n`)
          return
        }
        if (scan.agents.length === 0) {
          process.stdout.write('没有检测到可接入的 Agent。\n')
          return
        }
        for (const entry of scan.agents) {
          const variant = entry.variants.find((item) => item.id === entry.chosenVariant)
          const status = entry.registered
            ? `已接入·${entry.agentStatus ?? 'unknown'}`
            : variant?.adoptable === true
              ? '未接入'
              : `不可接入（${variant?.missingRequires.join('；') ?? '缺依赖'}）`
          process.stdout.write(
            `${entry.label}\t${entry.name}\t${status}\t${variant?.source ?? '-'}\n`,
          )
        }
        for (const problem of scan.problems) {
          process.stdout.write(`! 目录条目 ${problem.entryId}：${problem.message}\n`)
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  agent
    .command('adopt <catalogId>')
    .description('按内置目录接入一个 Agent（会启动它做一次 ACP 验证）')
    .option('--variant <id>', '目录条目的变体 id（如 dsh 的 desktop / cli）')
    .option('--json', '输出机器可读 JSON')
    .action(async (catalogId: string, options: { variant?: string; json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      const provider = createSrtProvider()
      try {
        migrate(db)
        const result = await adoptAgent({
          db,
          provider,
          home: dir,
          catalogId,
          ...(options.variant === undefined ? {} : { variantId: options.variant }),
        })
        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify({ ok: result.probe.ok, agent: result.agent, probe: result.probe }, null, 2)}\n`,
          )
        } else {
          process.stdout.write(
            `${result.probe.ok ? '✓' : '✗'} ${result.agent.name} 已接入：${describeProbe(result.probe)}\n`,
          )
          if (result.probe.status === 'needs_auth') {
            const methods = result.probe.authMethods.map((item) => item.name ?? item.id).join(' / ')
            process.stdout.write(`  需要登录：${methods}\n`)
          }
        }
        if (!result.probe.ok) process.exitCode = CLI_EXIT.RUNTIME
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        await provider.dispose().catch(() => undefined)
        db.close()
      }
    })

  agent
    .command('login <name>')
    .description('按 Agent 声明的登录方式完成认证（浏览器 / 设备码）')
    .requiredOption('--method <id>', '登录方式 id（见接入页或 agent adopt 输出）')
    .option('--json', '输出机器可读 JSON')
    .action(async (name: string, options: { method: string; json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      const provider = createSrtProvider()
      try {
        migrate(db)
        const result = await loginAgent({
          db,
          provider,
          home: dir,
          name,
          methodId: options.method,
        })
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } else {
          process.stdout.write(
            result.ok
              ? `✓ ${name} 登录完成，请运行 agent verify 确认\n`
              : `✗ 登录失败：${result.error?.message ?? ''}\n`,
          )
        }
        if (!result.ok) process.exitCode = CLI_EXIT.RUNTIME
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        await provider.dispose().catch(() => undefined)
        db.close()
      }
    })

  agent
    .command('verify <name>')
    .description('重新验证一个已接入的 Agent')
    .option('--json', '输出机器可读 JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      const provider = createSrtProvider()
      try {
        migrate(db)
        const result = await verifyAgent({ db, provider, home: dir, name })
        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify({ ok: result.probe.ok, agent: result.agent, probe: result.probe }, null, 2)}\n`,
          )
        } else {
          process.stdout.write(
            `${result.probe.ok ? '✓' : '✗'} ${name}：${describeProbe(result.probe)}\n`,
          )
        }
        if (!result.probe.ok) process.exitCode = CLI_EXIT.RUNTIME
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        await provider.dispose().catch(() => undefined)
        db.close()
      }
    })

  agent
    .command('list')
    .description('列出已注册的 Agent')
    .option('--json', '输出机器可读 JSON')
    .action((options: { json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      try {
        migrate(db)
        const agents = listAgents(db)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, agents }, null, 2)}\n`)
        } else if (agents.length === 0) {
          process.stdout.write('没有可进行 ACP 协议连接的 Agent。\n')
        } else {
          for (const item of agents) {
            process.stdout.write(
              `${item.name}\t${item.status}\t${item.networkMode}\t${item.command}\t${item.lastSeenAt ?? '-'}\n`,
            )
          }
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  agent
    .command('show <name>')
    .description('查看一个已注册 Agent')
    .option('--json', '输出机器可读 JSON')
    .action((name: string, options: { json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const record = resolveAgent(db, name)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, agent: record }, null, 2)}\n`)
        } else {
          process.stdout.write(`${record.name}\t${record.status}\t${record.command}\n`)
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  program
    .command('run')
    .description('固定脚本驱动的 ACP 任务（M4，不接 Brain）')
    .argument('<goal>', '要交给 Agent 的目标')
    .option('--agent <name>', '使用哪个已注册 Agent；只有一个时可省略')
    .option('--agents <names>', '逗号分隔的 Agent 列表；并行执行并各自使用 worktree')
    .option('--worktree <path>', '任务工作区 / git 仓库根（默认当前目录）')
    .option('--isolation <mode>', '工作区隔离：shared | worktree（默认 worktree）')
    .option('--transcript-dir <path>', 'ACP transcript 输出目录')
    .option('--network <mode>', '覆盖 Agent 的网络策略：agent-managed | allowlist | deny')
    .option(
      '--allow-domain <domain>',
      '仅 allowlist 模式：额外允许的域名（可重复）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--allow-write <path>',
      '额外允许写入的路径（可重复；harness 状态目录等）',
      (value: string, previous: string[]) => [...previous, resolve(value)],
      [],
    )
    .option('--prompt-timeout-ms <ms>', '单次 prompt 超时', (value) => Number.parseInt(value, 10))
    .option(
      '--verify-command <cmd>',
      '验收命令（可重复；退出码 0 为通过）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--verify-file <path>',
      '验收文件必须存在（可重复，worktree 相对路径）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--allowed-path <path>',
      'diffScope 允许的写入路径（可重复；默认 .）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--unexpected-path <path>',
      '不允许改动的关键路径（可重复）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--manual-review', '追加人工复核检查（verdict=manual_required）')
    .option('--artifact-dir <path>', '验收日志目录')
    .option('--approval-mode <mode>', 'sandbox_denied 的授权形态：once | policy')
    .option('--brain-mode <mode>', 'Brain 模式：pi | scripted（默认 pi）')
    .option('--no-brain', '跳过 Brain，使用 M4 固定脚本（仅排障）')
    .option('--json', '输出机器可读 JSON')
    .action(
      async (
        goal: string,
        options: {
          agent?: string
          agents?: string
          worktree?: string
          isolation?: string
          transcriptDir?: string
          network?: string
          allowDomain?: string[]
          allowWrite?: string[]
          promptTimeoutMs?: number
          verifyCommand?: string[]
          verifyFile?: string[]
          allowedPath?: string[]
          unexpectedPath?: string[]
          manualReview?: boolean
          artifactDir?: string
          approvalMode?: string
          brain?: boolean
          brainMode?: string
          json?: boolean
        },
      ) => {
        const dir = hubDir()
        let lock: Awaited<ReturnType<typeof acquireLock>> | undefined
        let db: ReturnType<typeof openDatabase> | undefined
        let session: WorktreeSession | undefined
        try {
          lock = await acquireLock(dir, lockPath(dir))
          db = openDatabase(dbPath(dir))
          migrate(db)
          const provider = createSrtProvider()
          const checks = buildVerificationChecks(options)

          if (options.agents !== undefined) {
            const names = options.agents
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean)
            if (names.length < 2) {
              throw new HubError('CONFIG_INVALID', '--agents 至少需要两个 Agent', {
                agents: names,
              })
            }
            const agents = names.map((name) => resolveAgent(db as NonNullable<typeof db>, name))
            const first = agents[0]
            if (first === undefined) {
              throw new HubError('CONFIG_INVALID', '--agents 为空')
            }
            const networkMode = parseNetworkMode(options.network, first.networkMode)
            const requestedDomains = options.allowDomain ?? []
            if (networkMode !== 'allowlist' && requestedDomains.length > 0) {
              throw new HubError(
                'CONFIG_INVALID',
                '--allow-domain 只在 --network allowlist 时生效；本地受信 Agent 默认 agent-managed 不需要它',
              )
            }
            const allowedDomains =
              networkMode === 'allowlist'
                ? [
                    ...new Set([
                      ...agents.flatMap((agent) => agent.allowedDomains),
                      ...requestedDomains,
                    ]),
                  ]
                : []
            const allowedWrite = [
              ...new Set([
                ...agents.flatMap((agent) => agent.allowedWrite),
                ...(options.allowWrite ?? []),
              ]),
            ]
            const brain =
              options.brain === false
                ? undefined
                : createBrainFromEnv({
                    ...process.env,
                    HUBAGENT_BRAIN_MODE:
                      options.brainMode ?? process.env.HUBAGENT_BRAIN_MODE ?? 'pi',
                  })
            const parallel = await runParallelAgents({
              db,
              provider,
              agents,
              ...(brain === undefined ? {} : { brain }),
              objective: goal,
              repoRoot: options.worktree ?? process.cwd(),
              checks,
              clientVersion: version,
              networkMode,
              ...(networkMode === 'allowlist' ? { allowedDomains } : {}),
              ...(allowedWrite.length === 0 ? {} : { allowedWrite }),
              ...(options.transcriptDir === undefined
                ? {}
                : { transcriptDir: options.transcriptDir }),
            })
            if (options.json === true) {
              process.stdout.write(`${JSON.stringify(parallel, null, 2)}\n`)
            } else {
              process.stdout.write(`${parallel.ok ? '✓' : '✗'} parallel task ${parallel.taskId}\n`)
              for (const item of parallel.subtasks) {
                process.stdout.write(
                  `  ${item.agent.name}\t${item.verdict}\t${item.branch}\t${item.worktree}\n`,
                )
              }
              for (const merge of parallel.merges) {
                process.stdout.write(`  merge ${merge.ok ? '✓' : '✗'} ${merge.branch}\n`)
              }
            }
            process.exitCode = parallel.ok ? 0 : 4
            return
          }

          const agentRecord = resolveAgent(db, options.agent)
          const networkMode = parseNetworkMode(options.network, agentRecord.networkMode)
          const requestedDomains = options.allowDomain ?? []
          if (networkMode !== 'allowlist' && requestedDomains.length > 0) {
            throw new HubError(
              'CONFIG_INVALID',
              '--allow-domain 只在 --network allowlist 时生效；本地受信 Agent 默认 agent-managed 不需要它',
            )
          }
          const allowedDomains =
            networkMode === 'allowlist'
              ? [...new Set([...agentRecord.allowedDomains, ...requestedDomains])]
              : []
          const allowedWrite = [
            ...new Set([...agentRecord.allowedWrite, ...(options.allowWrite ?? [])]),
          ]

          const isolation = options.isolation ?? 'worktree'
          if (isolation !== 'shared' && isolation !== 'worktree') {
            throw new HubError(
              'CONFIG_INVALID',
              `isolation 只能是 shared | worktree：${isolation}`,
              {
                isolation,
              },
            )
          }
          let effectiveWorktree = options.worktree ?? process.cwd()
          if (isolation === 'worktree') {
            session = await createWorktreeSession({
              db,
              provider,
              repoRoot: effectiveWorktree,
              agentId: agentRecord.id,
              networkMode,
              ...(networkMode === 'allowlist' ? { allowedDomains } : {}),
            })
            effectiveWorktree = session.worktreePath
          }

          const approvalDecisionMode =
            options.approvalMode === undefined ? undefined : parseApprovalMode(options.approvalMode)

          const effectiveAllowedWrite =
            session === undefined ? allowedWrite : [...allowedWrite, ...session.gitWritePaths]
          try {
            const common = {
              db,
              provider,
              agent: agentRecord,
              objective: goal,
              worktree: effectiveWorktree,
              ...(session === undefined ? {} : { executionId: session.executionId }),
              clientVersion: version,
              checks,
              ...(options.artifactDir === undefined ? {} : { artifactDir: options.artifactDir }),
              ...(approvalDecisionMode === undefined ? {} : { approvalDecisionMode }),
              ...(options.transcriptDir === undefined
                ? {}
                : { transcriptDir: options.transcriptDir }),
              networkMode,
              ...(networkMode === 'allowlist' ? { allowedDomains } : {}),
              ...(effectiveAllowedWrite.length === 0
                ? {}
                : { allowedWrite: effectiveAllowedWrite }),
              ...(options.promptTimeoutMs === undefined ||
              !Number.isFinite(options.promptTimeoutMs) ||
              options.promptTimeoutMs <= 0
                ? {}
                : { promptTimeoutMs: options.promptTimeoutMs }),
            }
            if (options.brain === false && options.brainMode !== undefined) {
              throw new HubError('CONFIG_INVALID', '--no-brain 与 --brain-mode 不能同时使用')
            }
            const brain =
              options.brain === false || options.brainMode === undefined
                ? undefined
                : createBrainFromEnv({
                    ...process.env,
                    HUBAGENT_BRAIN_MODE: options.brainMode,
                  })
            const result =
              options.brain === false
                ? await runAcpTask(common)
                : await runGoalWithBrain({
                    ...common,
                    availableAgents: listAgents(db),
                    completeOnSuccess: session === undefined,
                    ...(brain === undefined ? {} : { brain }),
                  })
            let outputResult: typeof result & {
              workspace?: {
                projectId: string
                repoRoot: string
                worktreePath: string
                branch: string
                leaseId: string
                delivery: unknown
              }
            } = result
            if (session !== undefined) {
              const active = session
              session = undefined
              const delivery = await finalizeWorktreeSession(db, active, result)
              outputResult = {
                ...result,
                workspace: {
                  projectId: active.projectId,
                  repoRoot: active.repoRoot,
                  worktreePath: active.worktreePath,
                  branch: active.branch,
                  leaseId: active.leaseId,
                  delivery,
                },
              }
            }

            if (options.json === true) {
              process.stdout.write(`${JSON.stringify(outputResult, null, 2)}\n`)
            } else {
              process.stdout.write(
                `${outputResult.ok ? '✓' : '✗'} task ${outputResult.taskId ?? '-'} / execution ${outputResult.executionId ?? '-'}\n`,
              )
              process.stdout.write(`  agent:      ${outputResult.agent.name}\n`)
              process.stdout.write(`  stopReason: ${outputResult.stopReason}\n`)
              process.stdout.write(`  verdict:    ${outputResult.verdict}\n`)
              const reply = (outputResult as { reply?: string }).reply
              if (reply !== undefined) {
                process.stdout.write(`\n${reply}\n`)
              }
              const decisions = (outputResult as { decisions?: readonly unknown[] }).decisions
              if (decisions !== undefined) {
                process.stdout.write(`  decisions:  ${decisions.length}\n`)
              }
              const workspace = (
                outputResult as { workspace?: { worktreePath: string; branch: string } }
              ).workspace
              if (workspace !== undefined) {
                process.stdout.write(`  worktree:   ${workspace.worktreePath}\n`)
                process.stdout.write(`  branch:     ${workspace.branch}\n`)
              }
              process.stdout.write(`  transcript: ${outputResult.transcriptRef ?? '-'}\n`)
              process.stdout.write(`  diffstat:   ${outputResult.evidence?.diffstat ?? '（无）'}\n`)
              if (outputResult.approval !== undefined) {
                process.stdout.write(
                  `  approval:   ${outputResult.approval.id} (${outputResult.approval.reason})\n`,
                )
              }
            }
            process.exitCode = exitCodeForRun(outputResult)
          } finally {
            await provider.dispose().catch(() => undefined)
          }
        } catch (error) {
          if (session !== undefined && db !== undefined) {
            await abortWorktreeSession(db, session).catch(() => undefined)
          }
          writeCliError(error, options.json === true)
        } finally {
          db?.close()
          await lock?.release().catch(() => undefined)
        }
      },
    )

  const task = program.command('task').description('任务查看')

  task
    .command('list')
    .description('列出最近任务')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10), 50)
    .option('--json', '输出机器可读 JSON')
    .action((options: { limit: number; json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const tasks = listTasks(db, options.limit)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, tasks }, null, 2)}\n`)
        } else {
          for (const task of tasks) {
            process.stdout.write(`${task.id}\t${task.status}\t${task.title}\n`)
          }
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  task
    .command('events <id>')
    .description('查看任务相关事件（原始事件只读视图）')
    .option('--json', '输出机器可读 JSON')
    .action((id: string, options: { json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const events = listTaskEvents(db, id)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, events }, null, 2)}\n`)
        } else if (events.length === 0) {
          process.stdout.write('没有事件。\n')
        } else {
          for (const event of events) {
            process.stdout.write(`${event.seq}\t${event.type}\t${event.aggregateId}\n`)
          }
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  task
    .command('evidence <id>')
    .description('查看任务证据（等价于 task show --evidence --json）')
    .option('--json', '输出机器可读 JSON')
    .action((id: string, options: { json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const view = getTaskEvidence(db, id)
        if (view === undefined) {
          throw new HubError('NOT_FOUND', `任务不存在：${id}`, { taskId: id })
        }
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...view }, null, 2)}\n`)
        } else {
          process.stdout.write(formatTaskEvidence(view, true))
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  for (const [name, action] of [
    ['pause', 'pause'],
    ['resume', 'resume'],
    ['cancel', 'cancel'],
  ] as const) {
    task
      .command(`${name} <id>`)
      .description(
        name === 'pause' ? '暂停任务并保留现场' : name === 'resume' ? '恢复暂停任务' : '取消任务',
      )
      .option('--json', '输出机器可读 JSON')
      .action((id: string, options: { json?: boolean }) => {
        const db = openDatabase(dbPath(hubDir()))
        try {
          migrate(db)
          const result =
            action === 'pause'
              ? pauseTask(db, id, 'cli pause')
              : action === 'resume'
                ? resumeTask(db, id)
                : cancelTask(db, id)
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
          } else {
            process.stdout.write(`✓ ${action} ${id}\n`)
          }
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          db.close()
        }
      })
  }

  task
    .command('retry <id>')
    .description('重试任务：paused 任务 resume；failed 任务创建新 attempt 并执行')
    .option('--agent <name>', 'failed 任务重试使用的 Agent；默认沿用最后一次执行')
    .option('--worktree <path>', '重试工作区；默认沿用失败任务的 lease 路径或当前目录')
    .option('--brain-mode <mode>', 'Brain 模式：pi | scripted（默认 llm 环境配置）')
    .option(
      '--verify-command <cmd>',
      '新 attempt 的验收命令（可重复）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--allowed-path <path>',
      'diffScope 允许路径（可重复；默认 .）',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--json', '输出机器可读 JSON')
    .action(
      async (
        id: string,
        options: {
          agent?: string
          worktree?: string
          brainMode?: string
          verifyCommand?: string[]
          allowedPath?: string[]
          json?: boolean
        },
      ) => {
        const db = openDatabase(dbPath(hubDir()))
        let provider: ReturnType<typeof createSrtProvider> | undefined
        try {
          migrate(db)
          const view = getTaskEvidence(db, id)
          if (view === undefined) {
            throw new HubError('NOT_FOUND', `任务不存在：${id}`, { taskId: id })
          }
          if (view.task.status === 'paused') {
            const result = resumeTask(db, id)
            if (options.json === true) {
              process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
            } else {
              process.stdout.write(`✓ resumed ${id}\n`)
            }
            return
          }
          if (view.task.status !== 'failed') {
            throw new HubError(
              'ACTION_REJECTED',
              `任务当前是 ${view.task.status}；只有 paused/failed 可以 retry`,
              { taskId: id, status: view.task.status },
            )
          }

          const lastExecution = [...view.executions]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1)
          const agents = listAgents(db)
          const lastAgent = agents.find((agent) => agent.id === lastExecution?.agentId)
          const agent =
            options.agent === undefined
              ? (lastAgent ?? resolveAgent(db))
              : resolveAgent(db, options.agent)
          const lease =
            lastExecution === undefined
              ? undefined
              : leasesForExecution(db, lastExecution.id).at(-1)
          const worktree = options.worktree ?? lease?.path ?? process.cwd()
          const checks = buildVerificationChecks(options)
          const brain = createBrainFromEnv({
            ...process.env,
            ...(options.brainMode === undefined ? {} : { HUBAGENT_BRAIN_MODE: options.brainMode }),
          })
          provider = createSrtProvider()
          const result = await runGoalWithBrain({
            db,
            provider,
            brain,
            agent,
            availableAgents: agents,
            objective: view.task.description,
            worktree,
            checks,
            clientVersion: version,
          })
          const payload = { retryOf: id, ...result }
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
          } else {
            process.stdout.write(`✓ retry ${id} -> task ${result.taskId}\n`)
          }
          process.exitCode = result.ok ? 0 : 1
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          await provider?.dispose().catch(() => undefined)
          db.close()
        }
      },
    )

  task
    .command('answer <questionId>')
    .description('回答 clarify/decide 问题；答案按 questionId + executionId 路由')
    .requiredOption('--value <text>', '答案')
    .option('--execution <id>', 'clarify 必须回显 executionId')
    .option('--json', '输出机器可读 JSON')
    .action(
      (questionId: string, options: { value: string; execution?: string; json?: boolean }) => {
        const db = openDatabase(dbPath(hubDir()))
        try {
          migrate(db)
          const answer = answerClarification(db, {
            questionId,
            answer: options.value,
            ...(options.execution === undefined ? {} : { executionId: options.execution }),
          })
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, answer }, null, 2)}\n`)
          } else {
            process.stdout.write(`✓ answered ${questionId}\n`)
          }
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          db.close()
        }
      },
    )

  task
    .command('clean <id>')
    .description('清理任务的 worktree 与租约；默认拒绝丢弃未提交改动')
    .option('--force', '强制丢弃 worktree 现场')
    .option('--json', '输出机器可读 JSON')
    .action(async (id: string, options: { force?: boolean; json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      let provider: ReturnType<typeof createSrtProvider> | undefined
      try {
        migrate(db)
        provider = createSrtProvider()
        const result = await cleanTaskWorkspace(db, provider, id, options.force === true)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
        } else if (result.removed.length === 0) {
          process.stdout.write('没有可清理的 worktree。\n')
        } else {
          for (const path of result.removed) process.stdout.write(`✓ removed ${path}\n`)
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        await provider?.dispose().catch(() => undefined)
        db.close()
      }
    })

  task
    .command('decisions <id>')
    .description('查看任务的 Brain 决策理由')
    .option('--json', '输出机器可读 JSON')
    .action((id: string, options: { json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const view = getTaskEvidence(db, id)
        if (view === undefined) {
          throw new HubError('NOT_FOUND', `任务不存在：${id}`, { taskId: id })
        }
        const decisions = listDecisions(db, view.task.goalId)
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, decisions }, null, 2)}\n`)
        } else if (decisions.length === 0) {
          process.stdout.write('没有 DecisionRecord。\n')
        } else {
          for (const item of decisions) {
            process.stdout.write(`${item.type}\t${item.rationale}\n`)
          }
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  task
    .command('show <id>')
    .description('查看任务、执行、验收证据与审批')
    .option('--evidence', '展开每条检查的命令、退出码与日志引用')
    .option('--json', '输出机器可读 JSON')
    .action((id: string, options: { evidence?: boolean; json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const view = getTaskEvidence(db, id)
        if (view === undefined) {
          throw new HubError('NOT_FOUND', `任务不存在：${id}`, { taskId: id })
        }
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...view }, null, 2)}\n`)
        } else {
          process.stdout.write(formatTaskEvidence(view, options.evidence === true))
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  const approval = program.command('approval').description('审批中心')

  approval
    .command('list')
    .description('列出审批项')
    .option('--task <id>', '只列出某个任务的审批')
    .option('--json', '输出机器可读 JSON')
    .action((options: { task?: string; json?: boolean }) => {
      const db = openDatabase(dbPath(hubDir()))
      try {
        migrate(db)
        const approvals = listApprovals(db).filter(
          (item) => options.task === undefined || item.taskId === options.task,
        )
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, approvals }, null, 2)}\n`)
        } else if (approvals.length === 0) {
          process.stdout.write('没有 Approval。\n')
        } else {
          for (const item of approvals) {
            process.stdout.write(`${item.id}\t${item.status}\t${item.reason}\t${item.resource}\n`)
          }
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
        db.close()
      }
    })

  for (const [name, status] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    approval
      .command(`${name} <id>`)
      .description(name === 'approve' ? '批准一个 Approval' : '拒绝一个 Approval')
      .option('--json', '输出机器可读 JSON')
      .action((id: string, options: { json?: boolean }) => {
        const db = openDatabase(dbPath(hubDir()))
        try {
          migrate(db)
          const state = decideApproval(db, id, status)
          const approvalRecord = state.approvals[id]
          if (options.json === true) {
            process.stdout.write(
              `${JSON.stringify({ ok: true, approval: approvalRecord }, null, 2)}\n`,
            )
          } else {
            process.stdout.write(
              `✓ approval ${id} → ${status}（仅记录裁决；下次执行需显式放宽 Agent profile）\n`,
            )
          }
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          db.close()
        }
      })
  }

  return program
}

function parseApprovalMode(value: string): 'once' | 'policy' {
  if (value === 'once' || value === 'policy') return value
  throw new HubError('CONFIG_INVALID', `approval-mode 只能是 once | policy：${value}`, { value })
}

function buildVerificationChecks(input: {
  verifyCommand?: string[]
  verifyFile?: string[]
  allowedPath?: string[]
  unexpectedPath?: string[]
  manualReview?: boolean
}): VerificationCheck[] {
  const commands = input.verifyCommand ?? []
  const files = input.verifyFile ?? []
  const unexpected = input.unexpectedPath ?? []
  const allowedPaths = input.allowedPath ?? []

  const checks: VerificationCheck[] = [
    ...commands.map(
      (cmd): VerificationCheck => ({
        kind: 'command',
        cmd,
        timeoutMs: 10 * 60_000,
        expect: { exitCode: 0 },
      }),
    ),
    ...files.map((path): VerificationCheck => ({ kind: 'fileExists', path })),
    { kind: 'diffScope', allowedPaths: allowedPaths.length > 0 ? allowedPaths : ['.'] },
    ...(unexpected.length > 0 ? [{ kind: 'noUnexpectedChange' as const, paths: unexpected }] : []),
  ]

  if (input.manualReview === true) {
    checks.push({ kind: 'llmReview', rubric: '人工复核', evidenceRefs: [] })
  }
  // 只有 diffScope 不能证明任务目标完成；没有可执行验收项时显式转人工。
  if (commands.length === 0 && files.length === 0 && input.manualReview !== true) {
    checks.push({
      kind: 'llmReview',
      rubric: '未提供可执行验收检查（--verify-command / --verify-file）',
      evidenceRefs: [],
    })
  }
  return checks
}

function formatTaskEvidence(
  view: NonNullable<ReturnType<typeof getTaskEvidence>>,
  withEvidence: boolean,
): string {
  const lines: string[] = []
  lines.push(`task ${view.task.id} [${view.task.status}] ${view.task.title}`)
  lines.push(
    `subtasks: ${view.subtasks.map((item) => `${item.id}:${item.status}`).join(', ') || '-'}`,
  )
  for (const execution of view.executions) {
    lines.push(`execution ${execution.id} [${execution.status}] attempt=${execution.attempt}`)
    const evidence = execution.evidence
    if (withEvidence && evidence !== undefined) {
      lines.push(`  evidence branch=${evidence.branch ?? '-'} commit=${evidence.commitSha ?? '-'}`)
      lines.push(`  diffstat: ${evidence.diffstat ?? '（无）'}`)
      lines.push(`  changed: ${evidence.changedFiles?.join(', ') ?? '（无）'}`)
      lines.push(`  transcript: ${evidence.transcriptRef ?? '（无）'}`)
    }
    for (const run of view.verifications.filter((item) => item.executionId === execution.id)) {
      lines.push(`  verification ${run.id} verdict=${run.verdict} by=${run.decidedBy}`)
      if (withEvidence) {
        for (const check of run.checks) {
          lines.push(
            `    ${check.checkId} ${check.kind} passed=${check.passed}` +
              `${check.command === undefined ? '' : ` cmd=${check.command}`}` +
              `${check.exitCode === undefined ? '' : ` exit=${check.exitCode}`}` +
              `${check.outputRef === undefined ? '' : ` log=${check.outputRef}`}`,
          )
        }
      }
    }
    for (const item of view.approvals.filter((approval) => approval.executionId === execution.id)) {
      lines.push(`  approval ${item.id} [${item.status}] ${item.reason}: ${item.resource}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function parseNetworkMode(
  value: string | undefined,
  fallback: SandboxNetworkMode,
): SandboxNetworkMode {
  if (value === undefined) return fallback
  if (value === 'agent-managed' || value === 'allowlist' || value === 'deny') return value
  throw new HubError(
    'CONFIG_INVALID',
    `network 只能是 agent-managed | allowlist | deny：${value}`,
    {
      value,
    },
  )
}

function directoryStats(path: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const file of walkFiles(path)) {
    files += 1
    bytes += statSync(file).size
  }
  return { files, bytes }
}

function walkFiles(path: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return []
  }
  const result: string[] = []
  for (const entry of entries) {
    const full = join(path, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) result.push(...walkFiles(full))
    else if (stat.isFile()) result.push(full)
  }
  return result
}

function listOldFiles(path: string, cutoffMs: number): string[] {
  return walkFiles(path).filter((file) => statSync(file).mtimeMs < cutoffMs)
}

function describeProbe(probe: {
  status: string
  durationMs: number
  error?: { code: string; message: string }
}): string {
  if (probe.status === 'online') return `在线（${probe.durationMs}ms）`
  if (probe.status === 'needs_auth') return '需要登录'
  return `失败：${probe.error?.code ?? 'UNEXPECTED'} ${probe.error?.message ?? ''}`.trim()
}

function writeCliError(error: unknown, json: boolean): void {
  const hubError =
    error instanceof HubError
      ? error
      : new HubError('UNEXPECTED', error instanceof Error ? error.message : String(error))
  process.exitCode = exitCodeFor(hubError)
  if (json) {
    process.stdout.write(`${JSON.stringify(hubError.toJSON(), null, 2)}\n`)
  } else {
    process.stderr.write(`✗ ${hubError.code}: ${hubError.message}\n`)
  }
}
