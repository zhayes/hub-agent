/**
 * 状态枚举与**合法迁移表**（PRD §6.5 / ARCHITECTURE §6.1）。
 *
 * 规则：任何状态变更都必须经过 checkTransition，不允许散落的 if。
 * 终态 = 迁移表里该状态对应空数组。
 */

export const GOAL_STATUSES = ['active', 'paused', 'completed', 'failed', 'canceled'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const TASK_STATUSES = [
  'draft',
  'planning',
  'ready',
  'running',
  'waiting_input',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const SUBTASK_STATUSES = [
  'blocked',
  'ready',
  'assigned',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
  'succeeded',
  'failed',
  'canceled',
  'skipped',
] as const
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number]

export const EXECUTION_STATUSES = [
  'created',
  'starting',
  'running',
  'waiting_permission',
  'waiting_input',
  'paused',
  'succeeded',
  'failed',
  'timeout',
  'canceled',
  'unknown',
] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  active: ['paused', 'completed', 'failed', 'canceled'],
  paused: ['active', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
}

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['planning', 'canceled'],
  planning: ['ready', 'failed', 'canceled'],
  ready: ['running', 'paused', 'canceled'],
  running: ['waiting_input', 'waiting_approval', 'paused', 'completed', 'failed', 'canceled'],
  waiting_input: ['running', 'paused', 'failed', 'canceled'],
  waiting_approval: ['running', 'paused', 'failed', 'canceled'],
  paused: ['running', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
}

export const SUBTASK_TRANSITIONS: Readonly<Record<SubtaskStatus, readonly SubtaskStatus[]>> = {
  blocked: ['ready', 'skipped', 'canceled'],
  ready: ['assigned', 'skipped', 'canceled'],
  assigned: ['running', 'failed', 'canceled'],
  running: ['waiting_approval', 'waiting_input', 'paused', 'succeeded', 'failed', 'canceled'],
  waiting_approval: ['running', 'failed', 'canceled'],
  waiting_input: ['running', 'failed', 'canceled'],
  paused: ['running', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  skipped: [],
}

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> =
  {
    created: ['starting', 'canceled'],
    starting: ['running', 'paused', 'failed', 'timeout', 'canceled'],
    running: [
      'waiting_permission',
      'waiting_input',
      'paused',
      'succeeded',
      'failed',
      'timeout',
      'canceled',
      'unknown',
    ],
    waiting_permission: ['running', 'paused', 'failed', 'timeout', 'canceled'],
    waiting_input: ['running', 'paused', 'failed', 'timeout', 'canceled'],
    // paused：中断但保留现场（worktree / session / 证据引用）；恢复走 → running。
    // 非预期退出（崩溃 / 断电）收敛到 unknown 走核验；Runtime 受控回收则保持 paused（PRD §6.5.5）。
    paused: ['running', 'failed', 'timeout', 'canceled', 'unknown'],
    succeeded: [],
    failed: [],
    timeout: [],
    canceled: [],
    // unknown 不代表结束：要先核验工作区再收敛（PRD §15.2）
    unknown: ['succeeded', 'failed', 'canceled'],
  }

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
}

/** 活跃执行：占用工作区与进程 */
/**
 * 活跃执行：正在占用进程（in flight）。
 *
 * 注意 `paused` **不在此列**：暂停意味着已经让出执行权，
 * 因此为止只能按“先暂停执行、再暂停 task”的顺序操作（不变量 I5）。
 *
 * 但暂停中的执行**仍然持有 worktree/租约**（现场不能被其他 Execution 覆盖），
 * 这一点在 M7 引入租约时需要单独区分，不能复用本判定。
 */
export const ACTIVE_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'starting',
  'running',
  'waiting_permission',
  'waiting_input',
]

export function isActiveExecution(status: ExecutionStatus): boolean {
  return ACTIVE_EXECUTION_STATUSES.includes(status)
}

export type TransitionRejection = 'ILLEGAL' | 'TERMINAL' | 'NOOP'

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: TransitionRejection; message: string }

export function isTerminalStatus<T extends string>(
  table: Readonly<Record<T, readonly T[]>>,
  status: T,
): boolean {
  return table[status].length === 0
}

export function checkTransition<T extends string>(
  table: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
  label: string,
): TransitionCheck {
  if (from === to) {
    return { ok: false, reason: 'NOOP', message: `${label}: 状态已为 ${from}` }
  }
  if (isTerminalStatus(table, from)) {
    return { ok: false, reason: 'TERMINAL', message: `${label}: ${from} 是终态，不可再迁移` }
  }
  if (!table[from].includes(to)) {
    return { ok: false, reason: 'ILLEGAL', message: `${label}: 不允许 ${from} → ${to}` }
  }
  return { ok: true }
}
