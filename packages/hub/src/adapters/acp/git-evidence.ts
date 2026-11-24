import type { AgentHost } from '../../agent-host/agent-host'
import { newId } from '../../shared/id'

/**
 * 执行结束后的 git 证据。
 *
 * 所有 git 命令都经 AgentHost（因此也经 SandboxProvider）启动，不直接使用
 * child_process；cwd 由 AgentHost 强制为 worktree。
 */
export interface GitEvidence {
  branch?: string
  commitSha?: string
  diffstat?: string
  changedFiles?: string[]
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function runGit(host: AgentHost, worktree: string, args: string): Promise<GitResult> {
  const process = await host.spawn(`git-${newId()}`, {
    worktree,
    command: `git ${args}`,
    sandbox: { allowedWrite: [] },
    timeouts: { startupMs: 5_000, idleMs: 5_000, totalMs: 20_000, killGraceMs: 500 },
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  })
  const exit = await process.wait()
  return {
    ok: exit.reason === 'exited' && exit.code === 0,
    stdout: exit.stdout.trim(),
    stderr: exit.stderr.trim(),
  }
}

export async function readGitHead(host: AgentHost, worktree: string): Promise<string | undefined> {
  const head = await runGit(host, worktree, 'rev-parse HEAD')
  return head.ok && head.stdout.length > 0 ? head.stdout : undefined
}

export async function collectGitEvidence(
  host: AgentHost,
  worktree: string,
  baseSha: string | undefined,
): Promise<GitEvidence> {
  const evidence: GitEvidence = {}

  const branch = await runGit(host, worktree, 'rev-parse --abbrev-ref HEAD')
  if (branch.ok && branch.stdout.length > 0) evidence.branch = branch.stdout

  const head = await runGit(host, worktree, 'rev-parse HEAD')
  if (head.ok && head.stdout.length > 0) evidence.commitSha = head.stdout

  if (baseSha !== undefined && baseSha.length > 0) {
    const stat = await runGit(host, worktree, `diff --stat ${baseSha}`)
    if (stat.ok && stat.stdout.length > 0) evidence.diffstat = stat.stdout

    const tracked = await runGit(host, worktree, `diff --name-only ${baseSha}`)
    const untracked = await runGit(host, worktree, 'ls-files --others --exclude-standard')
    const files = [
      ...(tracked.ok ? tracked.stdout.split('\n') : []),
      ...(untracked.ok ? untracked.stdout.split('\n') : []),
    ]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (files.length > 0) evidence.changedFiles = [...new Set(files)]
  } else {
    // 没有基线（非 git 仓库 / 空仓库）：至少给出工作区当前改动。
    const status = await runGit(host, worktree, 'status --porcelain')
    if (status.ok && status.stdout.length > 0) {
      const files = status.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0)
      if (files.length > 0) evidence.changedFiles = [...new Set(files)]
    }
  }

  return evidence
}
