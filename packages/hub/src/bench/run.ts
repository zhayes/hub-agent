import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentHost } from '../agent-host/agent-host'
import type { VerificationCheck } from '../domain/entities'
import { addAgent, resolveAgent } from '../runtime/agent-registry'
import { runGoalWithBrain } from '../runtime/brain-run'
import { createAgentHostGitRunner } from '../runtime/workspace/git'
import { createSrtProvider } from '../sandbox/srt-driver'
import { openDatabase } from '../storage/db'
import { migrate } from '../storage/migrate'
import { type BenchRecord, computeMetrics } from './metrics'
import { runRecoveryProbe } from './recovery-probe'

/**
 * M10 回归基线。默认用本地确定性 mock agent 跑编排/验收链路；
 * 这不是 LLM 质量基准，报告里明确 mode=mock。
 * 真实 harness 可用 --agent-command 替换。
 */

interface TaskSpec {
  id: string
  title: string
  objective: string
  category: string
  shouldNotSplit: boolean
  expectedVerdict: 'pass' | 'fail'
  checks: VerificationCheck[]
}

function args(): { suite: string; out?: string; agentCommand?: string } {
  const values = process.argv.slice(2)
  let suite = 'fixtures/regression-tasks'
  let out: string | undefined
  let agentCommand: string | undefined
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value === '--suite') suite = values[++i] ?? suite
    else if (value === '--out') out = values[++i]
    else if (value === '--agent-command') agentCommand = values[++i]
  }
  return {
    suite,
    ...(out === undefined ? {} : { out }),
    ...(agentCommand === undefined ? {} : { agentCommand }),
  }
}

function loadSuite(dir: string): TaskSpec[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as TaskSpec)
}

async function repo(provider: ReturnType<typeof createSrtProvider>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-bench-'))
  const host = new AgentHost({ provider })
  const runner = createAgentHostGitRunner(host, { allowedWrite: [dir] })
  try {
    await runner.run(['init', '-q'], dir)
    writeFileSync(join(dir, 'README.md'), '# bench repo\n', 'utf8')
    await runner.run(['add', 'README.md'], dir)
    await runner.run(
      ['-c', 'user.name=Bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'init'],
      dir,
    )
  } finally {
    await host.dispose().catch(() => undefined)
  }
  return dir
}

async function main(): Promise<void> {
  const options = args()
  const suite = loadSuite(options.suite)
  const agentCommand = options.agentCommand ?? `node ${resolve('fixtures/agents/mock-agent.mjs')}`
  const provider = createSrtProvider()
  const records: BenchRecord[] = []

  try {
    for (const task of suite) {
      const dir = await repo(provider)
      const db = openDatabase(':memory:')
      const started = Date.now()
      try {
        migrate(db)
        addAgent(db, { name: 'bench', command: agentCommand })
        const result = await runGoalWithBrain({
          db,
          provider,
          agent: resolveAgent(db, 'bench'),
          objective: task.objective,
          worktree: dir,
          clientVersion: 'bench',
          checks: task.checks,
        })
        const subtasks = db
          .prepare('SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?')
          .get(result.taskId) as { n: number }
        const approvals = db
          .prepare('SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?')
          .get(result.taskId) as { n: number }
        records.push({
          id: task.id,
          category: task.category,
          expectedVerdict: task.expectedVerdict,
          actualVerdict: result.verdict,
          ok: result.ok,
          shouldNotSplit: task.shouldNotSplit,
          subtasks: subtasks.n,
          decisions: result.decisions.length,
          approvals: approvals.n,
          durationMs: Date.now() - started,
        })
      } catch (error) {
        records.push({
          id: task.id,
          category: task.category,
          expectedVerdict: task.expectedVerdict,
          actualVerdict: 'not_run',
          ok: false,
          shouldNotSplit: task.shouldNotSplit,
          subtasks: 0,
          decisions: 0,
          approvals: 0,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        db.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  } finally {
    await provider.dispose().catch(() => undefined)
  }

  const recovery = runRecoveryProbe()
  const report = {
    generatedAt: new Date().toISOString(),
    suite: options.suite,
    mode: options.agentCommand === undefined ? 'mock' : 'custom-agent',
    note:
      options.agentCommand === undefined
        ? '确定性 mock agent：度量编排/验收链路，不代表 LLM 规划质量'
        : '自定义 Agent 命令；任务是否真实完成由 checks 决定',
    metrics: computeMetrics(records, recovery.ok ? 1 : 0),
    recovery,
    records,
  }
  if (options.out !== undefined) {
    mkdirSync(resolve(options.out, '..'), { recursive: true })
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 5
})
