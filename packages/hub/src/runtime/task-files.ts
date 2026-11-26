import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { HubError } from '../shared/errors'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { leasesForExecution } from './workspace/lease'
import { getProject } from './workspace/project'

const MAX_BYTES = 512 * 1024

export interface TaskFileView {
  path: string
  content: string
  truncated: boolean
  source: 'worktree' | 'project'
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

/** 只读：限制在任务改动文件 + 工作区内，供右侧栏预览。 */
export function readTaskFile(db: Db, taskId: string, requestedPath: string): TaskFileView {
  const path = normalize(requestedPath.trim())
  if (path === '' || isAbsolute(path) || path.split('/').includes('..')) {
    throw new HubError('ACTION_REJECTED', '非法文件路径', { path: requestedPath })
  }

  const state = loadState(db)
  if (state.tasks[taskId] === undefined) {
    throw new HubError('NOT_FOUND', '任务不存在', { taskId })
  }
  const executions = Object.values(state.executions)
    .filter((execution) => execution.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const changed = new Set(
    executions.flatMap((execution) => execution.evidence?.changedFiles ?? []).map(normalize),
  )
  if (!changed.has(path)) {
    throw new HubError('ACTION_REJECTED', '只能预览该任务改动过的文件', { path })
  }

  let root: string | undefined
  let source: TaskFileView['source'] = 'worktree'
  for (const execution of executions.toReversed()) {
    const leases = leasesForExecution(db, String(execution.id))
    const lease = leases.at(-1)
    if (lease === undefined) continue
    if (existsSync(lease.path)) {
      root = lease.path
      source = 'worktree'
      break
    }
    const project = getProject(db, lease.projectId)
    if (project !== undefined && existsSync(project.rootPath)) {
      root = project.rootPath
      source = 'project'
    }
  }
  if (root === undefined) {
    throw new HubError('ACTION_REJECTED', '工作区已回收，无法读取文件内容', { path })
  }

  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new HubError('ACTION_REJECTED', '文件不在工作区内', { path })
  }
  if (!existsSync(target)) {
    throw new HubError('NOT_FOUND', '文件不存在（可能已回收）', { path })
  }
  const real = realpathSync(target)
  const realRel = relative(realpathSync(root), real)
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new HubError('ACTION_REJECTED', '文件不在工作区内', { path })
  }

  const size = statSync(real).size
  if (size > MAX_BYTES) {
    throw new HubError('ACTION_REJECTED', `文件超过 ${MAX_BYTES / 1024}KB，暂不支持预览`, { path })
  }
  const buffer = readFileSync(real)
  if (buffer.includes(0)) {
    throw new HubError('ACTION_REJECTED', '二进制文件不支持预览', { path })
  }
  const content = buffer.toString('utf8')
  return { path, content, truncated: false, source }
}
