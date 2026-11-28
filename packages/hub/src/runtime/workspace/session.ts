import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { AgentHost } from '../../agent-host/agent-host'
import type { SandboxNetworkMode, SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import { hubDir } from '../../shared/paths'
import { type Db } from '../../storage/db'
import { completeTaskAfterDelivery } from './finalize'
import {
  addWorktree,
  createAgentHostGitRunner,
  type GitRunner,
  removeWorktree,
  revParse,
} from './git'
import { acquireLease, leasesForExecution, releaseLease } from './lease'
import { ensureProject, getProject } from './project'

export interface WorktreeSession {
  executionId: string
  projectId: string
  repoRoot: string
  worktreePath: string
  branch: string
  leaseId: string
  gitHost: AgentHost
  gitRunner: GitRunner
  /** Agent 写 git 元数据的最小路径集合；不含 hooks/config */
  gitWritePaths: string[]
}

export interface CreateWorktreeSessionOptions {
  db: Db
  provider: SandboxProvider
  repoRoot: string
  agentId: string
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
}

export async function createWorktreeSession(
  options: CreateWorktreeSessionOptions,
): Promise<WorktreeSession> {
  const project = ensureProject(options.db, options.repoRoot)
  const executionId = newId()
  const branch = `hubagent/${executionId}`
  const worktreesRoot = join(hubDir(), 'worktrees')
  mkdirSync(worktreesRoot, { recursive: true })
  const worktreePath = join(worktreesRoot, executionId)
  const lease = acquireLease(options.db, {
    projectId: project.id,
    executionId,
    mode: 'worktree',
    path: worktreePath,
    branch,
    baseRef: 'HEAD',
    holderAgentId: options.agentId,
  })
  const gitHost = new AgentHost({ provider: options.provider })
  const gitRunner = createAgentHostGitRunner(gitHost, {
    allowedWrite: [worktreesRoot],
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
  })

  try {
    await addWorktree(gitRunner, {
      repoRoot: options.repoRoot,
      path: worktreePath,
      branch,
      baseRef: 'HEAD',
    })
  } catch (error) {
    releaseLease(options.db, lease.id)
    await gitHost.dispose().catch(() => undefined)
    throw error
  }

  return {
    executionId,
    projectId: project.id,
    repoRoot: options.repoRoot,
    worktreePath,
    branch,
    leaseId: lease.id,
    gitHost,
    gitRunner,
    gitWritePaths: gitWritePaths(options.repoRoot, executionId),
  }
}

/**
 * worktree 的 `.git` 是指向 repoRoot/.git/worktrees/<id> 的文件；
 * Agent 要 commit 必须能写 index/objects/refs/logs，但不能写 hooks/config。
 */
function gitWritePaths(repoRoot: string, executionId: string): string[] {
  const git = join(repoRoot, '.git')
  return [
    join(git, 'objects'),
    join(git, 'worktrees', executionId),
    join(git, 'refs', 'heads', 'hubagent'),
    join(git, 'logs', 'refs', 'heads', 'hubagent'),
    join(git, 'COMMIT_EDITMSG'),
  ]
}

/**
 * 交付：把这次运行的分支与提交回报出去（`branch-only`）。
 *
 * 这是唯一发生在自动化路径上的“交付”：分支和 worktree 本来就在原处，
 * 不需要写文件、不用改 ref。`patch-export` 是用户在任务页上的显式动作
 * （`deliver.ts`），不会在这里被自动触发。
 */
export interface WorktreeDelivery {
  mode: 'branch-only'
  branch: string
  commitSha?: string
}

export async function finalizeWorktreeSession(
  db: Db,
  session: WorktreeSession,
  result: { taskId?: string; goalId: string; verdict: string },
): Promise<WorktreeDelivery | undefined> {
  try {
    /* 只回复、没建任务的对话回合没有东西可交付，但租约仍要在这里释放。 */
    if (result.taskId === undefined || result.verdict !== 'pass') return undefined
    const commitSha = await revParse(session.gitRunner, session.repoRoot, session.branch)
    const delivery: WorktreeDelivery = {
      mode: 'branch-only',
      branch: session.branch,
      ...(commitSha === undefined ? {} : { commitSha }),
    }
    completeTaskAfterDelivery(db, result.taskId, result.goalId)
    return delivery
  } finally {
    try {
      releaseLease(db, session.leaseId)
    } catch {
      // 已 release/expired
    }
    await session.gitHost.dispose().catch(() => undefined)
  }
}

export async function abortWorktreeSession(db: Db, session: WorktreeSession): Promise<void> {
  try {
    releaseLease(db, session.leaseId)
  } catch {
    // 已 release/expired
  } finally {
    await session.gitHost.dispose().catch(() => undefined)
  }
}

export interface CleanResult {
  removed: string[]
  released: string[]
}

export async function cleanTaskWorkspace(
  db: Db,
  provider: SandboxProvider,
  taskId: string,
  force: boolean,
): Promise<CleanResult> {
  // taskId 不是 executionId；先映射到该任务的所有 execution。
  const executions = db
    .prepare('SELECT id FROM executions WHERE task_id = ?')
    .all(taskId) as Array<{ id: string }>
  const targets = executions.flatMap((execution) => leasesForExecution(db, execution.id))
  const removed: string[] = []
  const released: string[] = []
  if (targets.length === 0) return { removed, released }

  const gitHost = new AgentHost({ provider })
  const runner = createAgentHostGitRunner(gitHost, {
    allowedWrite: targets.flatMap((item) => [item.path, dirname(item.path)]),
  })
  try {
    for (const item of targets) {
      const project = getProject(db, item.projectId)
      if (project === undefined) continue
      // 无论租约是否已 release，都先确认没有未提交改动；默认拒绝丢弃现场。
      const status = await runner.run(['-C', item.path, 'status', '--porcelain'], item.path)
      if (!force && status.ok && status.stdout.trim().length > 0) {
        throw new HubError('DELIVERY_CONFLICT', `worktree 仍有未提交改动：${item.path}`, {
          path: item.path,
        })
      }
      await removeWorktree(runner, project.rootPath, item.path)
      removeLeftoverDir(item.path)
      if (item.status === 'active') {
        releaseLease(db, item.id)
        released.push(item.id)
      }
      removed.push(item.path)
    }
  } finally {
    await gitHost.dispose().catch(() => undefined)
  }
  return { removed, released }
}

function removeLeftoverDir(path: string): void {
  const root = join(hubDir(), 'worktrees')
  if (path !== root && path.startsWith(`${root}${sep}`)) {
    rmSync(path, { recursive: true, force: true })
  }
}
