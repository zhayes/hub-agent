import { parseDiffStat } from '../../components/ui/diff-stat'
import type { TaskView } from '../../shared/api'

/**
 * 任务详情的判定口径（PLAN-CONSOLE-INTERACTION §5、US-007/008）。
 *
 * 一条硬规则：**验收不得自证**。结论只看 Runtime 跑出来的检查，不看 Agent 的措辞；
 * 并且只认“最新一次尝试”的验收——否则“上一轮挂了、这一轮过了”会被判成失败。
 *
 * 这里全是纯函数，好让四态与判决逻辑离开渲染单独测。
 */

/** 四个可渲染的相位（P5 门禁要求四态评审）。cancelled 单列：它是被人停的，不是失败。 */
export type TaskPhase = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

const FAIL_VERDICTS = new Set(['fail', 'failed'])
const PASS_VERDICTS = new Set(['pass', 'passed', 'verified'])
const FAIL_STATUSES = new Set(['failed', 'error'])
const WAITING_STATUSES = new Set(['waiting_approval', 'waiting_input', 'waiting'])
const DONE_STATUSES = new Set(['completed', 'succeeded'])
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])

export type TaskExecution = TaskView['executions'][number]
export type TaskVerification = TaskView['verifications'][number]
export type TaskCheck = TaskVerification['checks'][number]

function stamp(execution: TaskExecution): string {
  return execution.startedAt ?? execution.createdAt ?? ''
}

/** 最近一次尝试。时间戳缺失时以后出现的为准（列表本身按创建顺序）。 */
export function latestExecution(view: TaskView): TaskExecution | undefined {
  let latest: TaskExecution | undefined
  for (const execution of view.executions) {
    if (latest === undefined || stamp(execution) >= stamp(latest)) latest = execution
  }
  return latest
}

/** 决定结论的那一次验收：最新一次尝试的验收；这一轮还没验收就是 undefined。 */
export function currentVerification(view: TaskView): TaskVerification | undefined {
  const latest = latestExecution(view)
  if (latest === undefined) return view.verifications.at(-1)
  return view.verifications.filter((run) => run.executionId === latest.id).at(-1)
}

export function isPassingVerdict(verdict: string): boolean {
  return PASS_VERDICTS.has(verdict)
}

export function taskPhase(view: TaskView, pendingApprovals: number): TaskPhase {
  const verification = currentVerification(view)
  if (verification !== undefined && FAIL_VERDICTS.has(verification.verdict)) return 'failed'
  const status = view.task.status
  if (FAIL_STATUSES.has(status)) return 'failed'
  if (CANCELLED_STATUSES.has(status)) return 'cancelled'
  if (pendingApprovals > 0 || WAITING_STATUSES.has(status)) return 'waiting'
  if (DONE_STATUSES.has(status)) return 'done'
  return 'running'
}

/**
 * 最近一次失败归因的检查：放在结论旁边（§5.4「证据在结论旁边」）。
 * 只看当前这一轮，避免把上一轮的失败一直挂在页头。
 */
export function failingCheck(view: TaskView): TaskCheck | undefined {
  return currentVerification(view)?.checks.find((check) => !check.passed)
}

export interface DiffTotals {
  added: number
  removed: number
  files: number
}

const EMPTY_DIFF: DiffTotals = { added: 0, removed: 0, files: 0 }

/**
 * `git diff --stat` 的合计只从 summary 行取。
 * 文件行里的 `++++---` 是按比例画的条，数它等于把图形当数据。
 */
export function diffTotals(stat: string | undefined): DiffTotals {
  if (stat === undefined || stat === '') return EMPTY_DIFF
  const parsed = parseDiffStat(stat)
  const summary = parsed.summary ?? ''
  const added = /(\d+) insertion/.exec(summary)?.[1]
  const removed = /(\d+) deletion/.exec(summary)?.[1]
  const files = /(\d+) files? changed/.exec(summary)?.[1]
  return {
    added: added === undefined ? 0 : Number(added),
    removed: removed === undefined ? 0 : Number(removed),
    files: files === undefined ? parsed.files.length : Number(files),
  }
}

/** 有 diff 可看的那一次尝试：优先带补丁的，其次带文件清单的。 */
export function evidenceExecution(view: TaskView): TaskExecution | undefined {
  const executions = [...view.executions].reverse()
  const typed = executions.filter(
    (execution): execution is TaskExecution => execution !== undefined,
  )
  return (
    typed.find((execution) => (execution.evidence?.diff ?? '') !== '') ??
    typed.find((execution) => (execution.evidence?.changedFiles?.length ?? 0) > 0) ??
    latestExecution(view)
  )
}

/**
 * 从第一次开始到最后一次结束。还在跑的时候不给数：
 * 那是“已过去的片段”，报出来会被当成总时长。
 */
export function elapsedMs(view: TaskView): number | undefined {
  const stamps: number[] = []
  for (const execution of view.executions) {
    for (const value of [execution.startedAt, execution.createdAt, execution.finishedAt]) {
      if (value === undefined) continue
      const at = Date.parse(value)
      if (Number.isFinite(at)) stamps.push(at)
    }
  }
  if (stamps.length < 2) return undefined
  const span = Math.max(...stamps) - Math.min(...stamps)
  return span > 0 ? span : undefined
}

/** 一次尝试的用时：有起止才算。 */
export function attemptMs(execution: TaskExecution): number | undefined {
  if (execution.startedAt === undefined || execution.finishedAt === undefined) return undefined
  const start = Date.parse(execution.startedAt)
  const end = Date.parse(execution.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
  return end - start
}

/** 参与过这个任务的 Agent（去重、保持出现顺序）。 */
export function executionAgents(view: TaskView): string[] {
  const seen = new Set<string>()
  for (const execution of view.executions) {
    if (execution.agentId !== undefined && execution.agentId !== '') seen.add(execution.agentId)
  }
  return [...seen]
}

/** 复制到剪贴板的那段失败说明：只写能核对的事实，不写推测。 */
export function failureReport(view: TaskView): string {
  const check = failingCheck(view)
  const lines = [`${view.task.title} · ${view.task.id}`, `status: ${view.task.status}`]
  if (check === undefined) {
    const run = currentVerification(view)
    lines.push(`verification: ${run?.verdict ?? 'none'}`)
  } else {
    lines.push(`check: ${check.kind}${check.command === undefined ? '' : ` — ${check.command}`}`)
    if (check.exitCode !== undefined) lines.push(`exit: ${check.exitCode}`)
    if (check.outputRef !== undefined) lines.push(`output: ${check.outputRef}`)
  }
  return lines.join('\n')
}
