import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeliveryMode } from '../../domain/chat'
import { HubError } from '../../shared/errors'
import { hubDir } from '../../shared/paths'
import type { Db } from '../../storage/db'
import { getTaskEvidence } from '../../storage/queries/evidence'

/**
 * 交付（PRD §6.12.4）：验收通过之后才谈“这份产出怎么拿走”。
 *
 * 控制台里交付是**用户的一次显式动作**（任务页的「导出补丁」），不是会话设置：
 * 同一个任务的两次运行，用户可能一次想留分支、一次只想要 patch。
 *
 * 三种模式的现状（诚实版）：
 * - `branch-only`：默认。分支与 worktree 已经保留着，这里只回报它在哪里。
 * - `patch-export`：把补丁写到 `~/.hubagent/artifacts/<taskId>.patch`，路径回报给用户。
 * - `auto-merge`：**拒绝**。PRD 要求项目配置 `targetRef` 与 `autoMerge` 才允许合并，
 *   而项目记录里还没有这两个字段；宁可不合并，也不在这里猜目标分支。
 */

export interface DeliverResult {
  mode: DeliveryMode
  branch?: string
  commitSha?: string
  patchRef?: string
  files: number
  added: number
  removed: number
}

interface DiffSource {
  branch?: string
  commitSha?: string
  diff: string
  diffstat?: string
  changedFiles: string[]
}

function diffSource(db: Db, taskId: string): DiffSource | undefined {
  const view = getTaskEvidence(db, taskId)
  if (view === undefined) return undefined
  const withDiff = view.executions.filter(
    (execution) =>
      (execution.evidence?.diff ?? '') !== '' || execution.evidence?.diffstat !== undefined,
  )
  /* 取最后一次带证据的执行：交付要的是“最终那份改动”，不是某一轮中间的。 */
  const last = withDiff.at(-1)
  if (last === undefined) return undefined
  return {
    ...(last.evidence?.branch === undefined ? {} : { branch: last.evidence.branch }),
    ...(last.evidence?.commitSha === undefined ? {} : { commitSha: last.evidence.commitSha }),
    diff: last.evidence?.diff ?? '',
    ...(last.evidence?.diffstat === undefined ? {} : { diffstat: last.evidence.diffstat }),
    changedFiles: last.evidence?.changedFiles ?? [],
  }
}

function totalsOf(source: DiffSource): { files: number; added: number; removed: number } {
  /* 只从 `git diff --stat` 的 summary 行取：行里的 `++++---` 是按比例画的条。 */
  const summary = source.diffstat ?? ''
  const added = /(\d+) insertion/.exec(summary)?.[1]
  const removed = /(\d+) deletion/.exec(summary)?.[1]
  const files = /(\d+) files? changed/.exec(summary)?.[1]
  return {
    files: files === undefined ? source.changedFiles.length : Number(files),
    added: added === undefined ? 0 : Number(added),
    removed: removed === undefined ? 0 : Number(removed),
  }
}

/** 验收没通过就没有“产出”可交付（PRD §6.12.4：验收 pass 是交付的前置）。 */
function assertVerificationPassed(db: Db, taskId: string): void {
  const view = getTaskEvidence(db, taskId)
  const latest = view?.verifications.at(-1)
  if (latest === undefined) {
    throw new HubError('ACTION_REJECTED', '这个任务还没有验收结论，不能交付', { taskId })
  }
  if (latest.verdict !== 'pass') {
    throw new HubError('ACTION_REJECTED', `验收未通过（${latest.verdict}），不能交付`, {
      taskId,
      verdict: latest.verdict,
    })
  }
}

export function deliverTask(db: Db, taskId: string, mode: DeliveryMode): DeliverResult {
  assertVerificationPassed(db, taskId)
  const source = diffSource(db, taskId)
  if (source === undefined) {
    throw new HubError('ACTION_REJECTED', '这个任务没有可交付的改动', { taskId })
  }
  const totals = totalsOf(source)

  if (mode === 'auto-merge') {
    throw new HubError(
      'DELIVERY_CONFLICT',
      'auto-merge 需要项目配置 targetRef 与 autoMerge；当前未配置，已拒绝合并',
      { taskId },
    )
  }

  if (mode === 'patch-export') {
    if (source.diff === '') {
      throw new HubError('ACTION_REJECTED', '这个任务没有补丁内容可导出', { taskId })
    }
    const dir = join(hubDir(), 'artifacts')
    mkdirSync(dir, { recursive: true })
    const patchRef = join(dir, `${taskId}.patch`)
    writeFileSync(patchRef, source.diff, 'utf8')
    return {
      mode,
      ...(source.branch === undefined ? {} : { branch: source.branch }),
      ...(source.commitSha === undefined ? {} : { commitSha: source.commitSha }),
      patchRef,
      ...totals,
    }
  }

  return {
    mode: 'branch-only',
    ...(source.branch === undefined ? {} : { branch: source.branch }),
    ...(source.commitSha === undefined ? {} : { commitSha: source.commitSha }),
    ...totals,
  }
}
