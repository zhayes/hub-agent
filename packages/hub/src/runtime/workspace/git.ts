import type { AgentHost } from '../../agent-host/agent-host'
import type { SandboxNetworkMode } from '../../sandbox/types'
import { HubError } from '../../shared/errors'

export interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitResult>
}

export interface AgentHostGitRunnerOptions {
  allowedWrite?: readonly string[]
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 生产路径：所有 git 命令都经 AgentHost/SandboxProvider，Runtime 不直接 child_process。 */
export function createAgentHostGitRunner(
  host: AgentHost,
  options: AgentHostGitRunnerOptions = {},
): GitRunner {
  return {
    async run(args, cwd) {
      const process = await host.spawn(`git-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
        worktree: cwd,
        command: `git ${args.map(quote).join(' ')}`,
        sandbox: {
          allowedWrite: options.allowedWrite ?? [],
          ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
          ...(options.allowedDomains === undefined
            ? {}
            : { allowedDomains: options.allowedDomains }),
        },
        timeouts: { startupMs: 10_000, idleMs: 10_000, totalMs: 60_000, killGraceMs: 1_000 },
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024,
      })
      const exit = await process.wait()
      return {
        ok: exit.reason === 'exited' && exit.code === 0,
        code: exit.code,
        stdout: exit.stdout,
        stderr: exit.stderr,
      }
    },
  }
}

export interface AddWorktreeInput {
  repoRoot: string
  path: string
  branch: string
  baseRef: string
}

export async function addWorktree(runner: GitRunner, input: AddWorktreeInput): Promise<void> {
  const created = await runner.run(
    ['-C', input.repoRoot, 'worktree', 'add', '-b', input.branch, input.path, input.baseRef],
    input.repoRoot,
  )
  if (created.ok) return
  if (created.stderr.includes('already exists')) {
    const attached = await runner.run(
      ['-C', input.repoRoot, 'worktree', 'add', input.path, input.branch],
      input.repoRoot,
    )
    if (attached.ok) return
    throw new HubError('DELIVERY_CONFLICT', `无法挂载 worktree：${attached.stderr}`, {
      path: input.path,
      branch: input.branch,
    })
  }
  throw new HubError('DELIVERY_CONFLICT', `无法创建 worktree：${created.stderr}`, {
    path: input.path,
    branch: input.branch,
  })
}

export async function removeWorktree(
  runner: GitRunner,
  repoRoot: string,
  path: string,
): Promise<void> {
  const result = await runner.run(['-C', repoRoot, 'worktree', 'remove', '--force', path], repoRoot)
  if (result.ok) return
  if (result.stderr.includes('not a working tree') || result.stderr.includes('No such file')) return
  throw new HubError('DELIVERY_CONFLICT', `无法移除 worktree：${result.stderr}`, { path })
}

export async function pruneWorktrees(runner: GitRunner, repoRoot: string): Promise<void> {
  await runner.run(['-C', repoRoot, 'worktree', 'prune'], repoRoot)
}

export async function mergeNoFf(
  runner: GitRunner,
  repoRoot: string,
  sourceRef: string,
): Promise<GitResult> {
  // merge --no-ff 会创建 commit；CI 的干净环境没有全局 git identity。
  const result = await runner.run(
    [
      '-C',
      repoRoot,
      '-c',
      'user.name=HubAgent',
      '-c',
      'user.email=hubagent@local',
      'merge',
      '--no-ff',
      '--no-edit',
      sourceRef,
    ],
    repoRoot,
  )
  if (!result.ok) {
    throw new HubError('DELIVERY_CONFLICT', `合并冲突：${sourceRef}`, {
      sourceRef,
      stderr: result.stderr.slice(0, 2000),
    })
  }
  return result
}

export async function resetHard(runner: GitRunner, repoRoot: string, ref: string): Promise<void> {
  const result = await runner.run(['-C', repoRoot, 'reset', '--hard', ref], repoRoot)
  if (!result.ok) {
    throw new HubError('DELIVERY_CONFLICT', `回滚失败：${ref}`, { ref, stderr: result.stderr })
  }
}

export async function revParse(
  runner: GitRunner,
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  const result = await runner.run(['-C', repoRoot, 'rev-parse', ref], repoRoot)
  return result.ok ? result.stdout.trim() : undefined
}
