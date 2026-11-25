import type { AgentHost } from '../../agent-host/agent-host'
import type { SandboxNetworkMode } from '../../sandbox/types'
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
  /** Unified patch, capped: a huge generated-file diff must not fill the DB. */
  diff?: string
  diffTruncated?: boolean
}

const MAX_DIFF_CHARS = 256 * 1024

/** Cap a patch before it reaches the DB; a lockfile diff can be megabytes. */
export function capPatch(
  text: string,
  max: number = MAX_DIFF_CHARS,
): {
  diff: string
  truncated: boolean
} {
  if (text.length <= max) return { diff: text, truncated: false }
  return { diff: text.slice(0, max), truncated: true }
}

export interface GitSandboxOptions {
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function runGit(
  host: AgentHost,
  worktree: string,
  args: string,
  sandbox: GitSandboxOptions = {},
): Promise<GitResult> {
  const process = await host.spawn(`git-${newId()}`, {
    worktree,
    command: `git ${args}`,
    sandbox: {
      allowedWrite: [],
      ...(sandbox.networkMode === undefined ? {} : { networkMode: sandbox.networkMode }),
      ...(sandbox.allowedDomains === undefined ? {} : { allowedDomains: sandbox.allowedDomains }),
    },
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

export async function readGitHead(
  host: AgentHost,
  worktree: string,
  sandbox: GitSandboxOptions = {},
): Promise<string | undefined> {
  const head = await runGit(host, worktree, 'rev-parse HEAD', sandbox)
  return head.ok && head.stdout.length > 0 ? head.stdout : undefined
}

export async function collectGitEvidence(
  host: AgentHost,
  worktree: string,
  baseSha: string | undefined,
  sandbox: GitSandboxOptions = {},
): Promise<GitEvidence> {
  const evidence: GitEvidence = {}

  const branch = await runGit(host, worktree, 'rev-parse --abbrev-ref HEAD', sandbox)
  if (branch.ok && branch.stdout.length > 0) evidence.branch = branch.stdout

  const head = await runGit(host, worktree, 'rev-parse HEAD', sandbox)
  if (head.ok && head.stdout.length > 0) evidence.commitSha = head.stdout

  if (baseSha !== undefined && baseSha.length > 0) {
    const stat = await runGit(host, worktree, `diff --stat ${baseSha}`, sandbox)
    if (stat.ok && stat.stdout.length > 0) evidence.diffstat = stat.stdout

    const patch = await runGit(host, worktree, `diff ${baseSha}`, sandbox)
    if (patch.ok && patch.stdout.length > 0) {
      const capped = capPatch(patch.stdout)
      evidence.diff = capped.diff
      if (capped.truncated) evidence.diffTruncated = true
    }

    const tracked = await runGit(host, worktree, `diff --name-only ${baseSha}`, sandbox)
    const untracked = await runGit(host, worktree, 'ls-files --others --exclude-standard', sandbox)
    const files = [
      ...(tracked.ok ? tracked.stdout.split('\n') : []),
      ...(untracked.ok ? untracked.stdout.split('\n') : []),
    ]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (files.length > 0) evidence.changedFiles = [...new Set(files)]
  } else {
    // 没有基线（非 git 仓库 / 空仓库）：至少给出工作区当前改动。
    const status = await runGit(host, worktree, 'status --porcelain', sandbox)
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
