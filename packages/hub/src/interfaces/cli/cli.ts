import { resolve } from 'node:path'
import { Command } from 'commander'
import { runAcpTask } from '../../runtime/acp-run'
import { addAgent, listAgents, resolveAgent } from '../../runtime/agent-registry'
import { createSrtProvider } from '../../sandbox/srt-driver'
import { HubError } from '../../shared/errors'
import { acquireLock } from '../../shared/lock'
import { dbPath, hubDir, lockPath } from '../../shared/paths'
import { openDatabase } from '../../storage/db'
import { migrate } from '../../storage/migrate'
import { runDoctor } from './doctor'
import { formatReport, runRebuildProjections } from './maintenance'

/**
 * CLI 只做"解析参数 + 输出"，不做业务判断。
 * M0 只有 doctor；M2 增加 maintenance；run/task/agent 等在 M4/M9 接入。
 */
export function createCli(version: string): Command {
  const program = new Command()

  program.name('hubagent').description('HubAgent — 本地优先的多 Agent 编排系统').version(version)

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

      process.exitCode = report.ok ? 0 : 1
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
        process.exitCode = report.ok ? 0 : 1
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
    .option('--json', '输出机器可读 JSON')
    .action(async (options: { name: string; cmd: string; json?: boolean }) => {
      const dir = hubDir()
      const db = openDatabase(dbPath(dir))
      try {
        migrate(db)
        const record = addAgent(db, { name: options.name, command: options.cmd })
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ ok: true, agent: record }, null, 2)}\n`)
        } else {
          process.stdout.write(`✓ agent ${record.name} 已注册（${record.id}）\n`)
        }
      } catch (error) {
        writeCliError(error, options.json === true)
      } finally {
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
              `${item.name}\t${item.status}\t${item.command}\t${item.lastSeenAt ?? '-'}\n`,
            )
          }
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
    .option('--worktree <path>', '任务工作区（默认当前目录）')
    .option('--transcript-dir <path>', 'ACP transcript 输出目录')
    .option(
      '--allow-domain <domain>',
      '允许访问的域名（可重复；默认全禁）',
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
    .option('--json', '输出机器可读 JSON')
    .action(
      async (
        goal: string,
        options: {
          agent?: string
          worktree?: string
          transcriptDir?: string
          allowDomain?: string[]
          allowWrite?: string[]
          promptTimeoutMs?: number
          json?: boolean
        },
      ) => {
        const dir = hubDir()
        let lock: Awaited<ReturnType<typeof acquireLock>> | undefined
        let db: ReturnType<typeof openDatabase> | undefined
        try {
          lock = await acquireLock(dir, lockPath(dir))
          db = openDatabase(dbPath(dir))
          migrate(db)
          const agentRecord = resolveAgent(db, options.agent)
          const provider = createSrtProvider()

          try {
            const result = await runAcpTask({
              db,
              provider,
              agent: agentRecord,
              objective: goal,
              worktree: options.worktree ?? process.cwd(),
              clientVersion: version,
              ...(options.transcriptDir === undefined
                ? {}
                : { transcriptDir: options.transcriptDir }),
              ...(options.allowDomain === undefined || options.allowDomain.length === 0
                ? {}
                : { allowedDomains: options.allowDomain }),
              ...(options.allowWrite === undefined || options.allowWrite.length === 0
                ? {}
                : { allowedWrite: options.allowWrite }),
              ...(options.promptTimeoutMs === undefined ||
              !Number.isFinite(options.promptTimeoutMs) ||
              options.promptTimeoutMs <= 0
                ? {}
                : { promptTimeoutMs: options.promptTimeoutMs }),
            })

            if (options.json === true) {
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
            } else {
              process.stdout.write(
                `${result.ok ? '✓' : '✗'} task ${result.taskId} / execution ${result.executionId}\n`,
              )
              process.stdout.write(`  agent:      ${result.agent.name}\n`)
              process.stdout.write(`  stopReason: ${result.stopReason}\n`)
              process.stdout.write(`  transcript: ${result.transcriptRef}\n`)
              process.stdout.write(`  diffstat:   ${result.evidence.diffstat ?? '（无）'}\n`)
            }
            process.exitCode = result.ok ? 0 : 1
          } finally {
            await provider.dispose().catch(() => undefined)
          }
        } catch (error) {
          writeCliError(error, options.json === true)
        } finally {
          db?.close()
          await lock?.release().catch(() => undefined)
        }
      },
    )

  return program
}

function writeCliError(error: unknown, json: boolean): void {
  const hubError =
    error instanceof HubError
      ? error
      : new HubError('UNEXPECTED', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
  if (json) {
    process.stdout.write(`${JSON.stringify(hubError.toJSON(), null, 2)}\n`)
  } else {
    process.stderr.write(`✗ ${hubError.code}: ${hubError.message}\n`)
  }
}
