import {
  type Approval,
  type Execution,
  type Goal,
  hasEvidence,
  isVerified,
  type Subtask,
  type Task,
  type VerificationRun,
} from './entities'
import type { DomainEvent } from './events'
import type { TaskId } from './ids'
import {
  APPROVAL_TRANSITIONS,
  checkTransition,
  EXECUTION_TRANSITIONS,
  GOAL_TRANSITIONS,
  isActiveExecution,
  isTerminalStatus,
  SUBTASK_TRANSITIONS,
  TASK_TRANSITIONS,
  type TransitionCheck,
} from './status'

/**
 * 领域状态：一次可整体快照的只读视图。
 * 所有变更只能通过 applyEvent 产生（不可变更新）。
 */
export interface DomainState {
  /** 多 goal：本地单用户不等于只能有一个目标（PRD §6.5.2 的 Goal 是一对多根） */
  goals: Readonly<Record<string, Goal>>
  tasks: Readonly<Record<string, Task>>
  subtasks: Readonly<Record<string, Subtask>>
  executions: Readonly<Record<string, Execution>>
  verifications: Readonly<Record<string, VerificationRun>>
  approvals: Readonly<Record<string, Approval>>
}

export const emptyState: DomainState = {
  goals: {},
  tasks: {},
  subtasks: {},
  executions: {},
  verifications: {},
  approvals: {},
}

export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'ILLEGAL_TRANSITION'
  | 'TERMINAL_STATE'
  | 'INVARIANT_BLOCKED'

export interface DomainError {
  code: DomainErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * 拒绝时返回**原状态引用**：调用方可以断言"被拒绝的迁移不改变状态"。
 */
export type ApplyOutcome =
  | { ok: true; state: DomainState }
  | { ok: false; state: DomainState; error: DomainError }

function accept(state: DomainState): ApplyOutcome {
  return { ok: true, state }
}

function reject(
  state: DomainState,
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApplyOutcome {
  return {
    ok: false,
    state,
    error: details === undefined ? { code, message } : { code, message, details },
  }
}

function asDomainError(check: Extract<TransitionCheck, { ok: false }>): DomainError {
  return {
    code: check.reason === 'TERMINAL' ? 'TERMINAL_STATE' : 'ILLEGAL_TRANSITION',
    message: check.message,
  }
}

function subtasksOfTask(state: DomainState, taskId: TaskId): Subtask[] {
  return Object.values(state.subtasks).filter((subtask) => subtask.taskId === taskId)
}

function executionsUnderTask(state: DomainState, taskId: TaskId): Execution[] {
  const subtaskIds = new Set(subtasksOfTask(state, taskId).map((subtask) => subtask.id))
  return Object.values(state.executions).filter((execution) => subtaskIds.has(execution.subtaskId))
}

/** 子任务成功的前提：存在带证据的成功执行，且该执行有通过的验收 */
function hasVerifiableSuccess(state: DomainState, subtask: Subtask): boolean {
  const succeeded = Object.values(state.executions).filter(
    (execution) => execution.subtaskId === subtask.id && execution.status === 'succeeded',
  )
  if (succeeded.length === 0) return false

  return succeeded.some((execution) =>
    Object.values(state.verifications).some(
      (run) => run.executionId === execution.id && isVerified(run),
    ),
  )
}

export function applyEvent(state: DomainState, event: DomainEvent): ApplyOutcome {
  switch (event.type) {
    case 'goal.created': {
      const id = event.goal.id
      if (state.goals[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `goal 已存在：${id}`)
      }
      // 创建事件不得伪造状态：新 goal 只能是 active
      if (event.goal.status !== 'active') {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `goal 初始状态只能是 active，收到 ${event.goal.status}`,
        )
      }
      return accept({ ...state, goals: { ...state.goals, [id]: event.goal } })
    }

    case 'goal.status': {
      const goal = state.goals[event.goalId]
      if (goal === undefined) {
        return reject(state, 'NOT_FOUND', `goal 不存在：${event.goalId}`)
      }
      const check = checkTransition(GOAL_TRANSITIONS, goal.status, event.to, `goal ${goal.id}`)
      if (!check.ok) return reject(state, asDomainError(check).code, check.message)
      return accept({
        ...state,
        goals: {
          ...state.goals,
          [goal.id]: { ...goal, status: event.to, updatedAt: event.at },
        },
      })
    }

    case 'task.created': {
      const id = event.task.id
      if (state.tasks[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `task 已存在：${id}`)
      }
      if (state.goals[event.task.goalId] === undefined) {
        return reject(state, 'NOT_FOUND', `goal 不存在：${event.task.goalId}`)
      }
      // 创建事件不得伪造状态：新 task 只能是 draft / ready
      if (event.task.status !== 'draft' && event.task.status !== 'ready') {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `task 初始状态只能是 draft / ready，收到 ${event.task.status}`,
        )
      }
      return accept({ ...state, tasks: { ...state.tasks, [id]: event.task } })
    }

    case 'task.status': {
      const task = state.tasks[event.taskId]
      if (task === undefined) {
        return reject(state, 'NOT_FOUND', `task 不存在：${event.taskId}`)
      }

      const check = checkTransition(TASK_TRANSITIONS, task.status, event.to, `task ${task.id}`)
      if (!check.ok) return reject(state, asDomainError(check).code, check.message)

      // 守卫 I1：必需子任务未收敛，不得 completed
      if (event.to === 'completed') {
        const pending = subtasksOfTask(state, task.id).filter(
          (subtask) =>
            subtask.required && subtask.status !== 'succeeded' && subtask.status !== 'skipped',
        )
        if (pending.length > 0) {
          return reject(state, 'INVARIANT_BLOCKED', `task ${task.id} 仍有未完成的必需子任务`, {
            subtaskIds: pending.map((subtask) => subtask.id),
          })
        }
      }

      // 守卫 I5：暂停前必须已经没有活跃执行（传播由 Runtime 逐个停止后完成）
      if (event.to === 'paused') {
        const active = executionsUnderTask(state, task.id).filter((execution) =>
          isActiveExecution(execution.status),
        )
        if (active.length > 0) {
          return reject(state, 'INVARIANT_BLOCKED', `暂停 task ${task.id} 前必须先停止活跃执行`, {
            executionIds: active.map((execution) => execution.id),
          })
        }
      }

      return accept({
        ...state,
        tasks: {
          ...state.tasks,
          [task.id]: { ...task, status: event.to, updatedAt: event.at },
        },
      })
    }

    case 'subtask.created': {
      const id = event.subtask.id
      if (state.subtasks[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `subtask 已存在：${id}`)
      }
      if (state.tasks[event.subtask.taskId] === undefined) {
        return reject(state, 'NOT_FOUND', `task 不存在：${event.subtask.taskId}`)
      }
      // 创建事件不得伪造状态：否则 subtask 一出生就 succeeded，I1 会放行整个 task
      if (event.subtask.status !== 'blocked' && event.subtask.status !== 'ready') {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `subtask 初始状态只能是 blocked / ready，收到 ${event.subtask.status}`,
        )
      }
      return accept({ ...state, subtasks: { ...state.subtasks, [id]: event.subtask } })
    }

    case 'subtask.assigned': {
      const subtask = state.subtasks[event.subtaskId]
      if (subtask === undefined) {
        return reject(state, 'NOT_FOUND', `subtask 不存在：${event.subtaskId}`)
      }
      /* 只记录“派给谁”，不改状态：状态迁移仍由 subtask.status 负责。 */
      return accept({
        ...state,
        subtasks: {
          ...state.subtasks,
          [event.subtaskId]: {
            ...subtask,
            assignedAgentId: event.agentId,
            updatedAt: event.at,
          },
        },
      })
    }

    case 'subtask.status': {
      const subtask = state.subtasks[event.subtaskId]
      if (subtask === undefined) {
        return reject(state, 'NOT_FOUND', `subtask 不存在：${event.subtaskId}`)
      }

      const check = checkTransition(
        SUBTASK_TRANSITIONS,
        subtask.status,
        event.to,
        `subtask ${subtask.id}`,
      )
      if (!check.ok) return reject(state, asDomainError(check).code, check.message)

      // 守卫 I2：没有"成功执行 + 通过验收"，不得 succeeded
      if (event.to === 'succeeded' && !hasVerifiableSuccess(state, subtask)) {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `subtask ${subtask.id} 缺少「成功执行 + 通过验收」的证据链`,
        )
      }

      return accept({
        ...state,
        subtasks: {
          ...state.subtasks,
          [subtask.id]: { ...subtask, status: event.to, updatedAt: event.at },
        },
      })
    }

    case 'execution.created': {
      const id = event.execution.id
      if (state.executions[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `execution 已存在：${id}`)
      }
      const subtask = state.subtasks[event.execution.subtaskId]
      if (subtask === undefined) {
        return reject(state, 'NOT_FOUND', `subtask 不存在：${event.execution.subtaskId}`)
      }
      if (subtask.taskId !== event.execution.taskId) {
        return reject(state, 'INVARIANT_BLOCKED', 'execution.taskId 与 subtask 所属 task 不一致')
      }
      // 创建事件不得伪造状态：新 execution 只能是 created（不得带 succeeded）
      if (event.execution.status !== 'created') {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `execution 初始状态只能是 created，收到 ${event.execution.status}`,
        )
      }
      return accept({
        ...state,
        executions: { ...state.executions, [id]: event.execution },
      })
    }

    case 'execution.status': {
      const execution = state.executions[event.executionId]
      if (execution === undefined) {
        return reject(state, 'NOT_FOUND', `execution 不存在：${event.executionId}`)
      }

      const check = checkTransition(
        EXECUTION_TRANSITIONS,
        execution.status,
        event.to,
        `execution ${execution.id}`,
      )
      if (!check.ok) return reject(state, asDomainError(check).code, check.message)

      // 守卫 I3：没有证据不得 succeeded
      if (event.to === 'succeeded' && !hasEvidence(execution.evidence)) {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `execution ${execution.id} 没有证据，不得判定成功`,
        )
      }

      // 守卫 I5（反向）：task 暂停期间不得让执行进入活跃状态。
      // 没有这一条就会出现“task 已 paused、execution 却在 running”的非法组合（属性测试抓到的）。
      if (isActiveExecution(event.to)) {
        const parentSubtask = state.subtasks[execution.subtaskId]
        const parentTask =
          parentSubtask === undefined ? undefined : state.tasks[parentSubtask.taskId]
        if (parentTask !== undefined && parentTask.status === 'paused') {
          return reject(
            state,
            'INVARIANT_BLOCKED',
            `task ${parentTask.id} 已暂停，不得启动或恢复执行 ${execution.id}`,
            { executionIds: [execution.id] },
          )
        }
      }

      return accept({
        ...state,
        executions: {
          ...state.executions,
          [execution.id]: {
            ...execution,
            status: event.to,
            ...(event.to === 'starting' && execution.startedAt === undefined
              ? { startedAt: event.at }
              : {}),
            ...(isTerminalStatus(EXECUTION_TRANSITIONS, event.to) ? { finishedAt: event.at } : {}),
          },
        },
      })
    }

    case 'execution.evidence': {
      const execution = state.executions[event.executionId]
      if (execution === undefined) {
        return reject(state, 'NOT_FOUND', `execution 不存在：${event.executionId}`)
      }
      // unknown 需要补证据来收敛；其他终态不再接受新证据
      if (
        isTerminalStatus(EXECUTION_TRANSITIONS, execution.status) &&
        execution.status !== 'unknown'
      ) {
        return reject(
          state,
          'ILLEGAL_TRANSITION',
          `execution ${execution.id} 已终结（${execution.status}），不再接受证据`,
        )
      }
      return accept({
        ...state,
        executions: {
          ...state.executions,
          [execution.id]: { ...execution, evidence: event.evidence },
        },
      })
    }

    case 'verification.recorded': {
      const id = event.run.id
      if (state.verifications[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `verification 已存在：${id}`)
      }
      if (state.executions[event.run.executionId] === undefined) {
        return reject(state, 'NOT_FOUND', `execution 不存在：${event.run.executionId}`)
      }
      // 判定 pass 必须有至少一条检查，且全部通过；否则只能是 manual_required / fail
      if (
        event.run.verdict === 'pass' &&
        (event.run.checks.length === 0 || !event.run.checks.every((check) => check.passed))
      ) {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `verification ${id} 判定为 pass，但缺少通过的可执行检查`,
          { checks: event.run.checks.length },
        )
      }
      return accept({
        ...state,
        verifications: { ...state.verifications, [id]: event.run },
      })
    }

    case 'approval.requested': {
      const id = event.approval.id
      if (state.approvals[id] !== undefined) {
        return reject(state, 'DUPLICATE_ID', `approval 已存在：${id}`)
      }
      if (state.tasks[event.approval.taskId] === undefined) {
        return reject(state, 'NOT_FOUND', `task 不存在：${event.approval.taskId}`)
      }
      // 创建事件不得伪造状态：新审批只能是 pending（不得直接 approved）
      if (event.approval.status !== 'pending') {
        return reject(
          state,
          'INVARIANT_BLOCKED',
          `approval 初始状态只能是 pending，收到 ${event.approval.status}`,
        )
      }
      return accept({ ...state, approvals: { ...state.approvals, [id]: event.approval } })
    }

    case 'approval.decided': {
      const approval = state.approvals[event.approvalId]
      if (approval === undefined) {
        return reject(state, 'NOT_FOUND', `approval 不存在：${event.approvalId}`)
      }
      const check = checkTransition(
        APPROVAL_TRANSITIONS,
        approval.status,
        event.status,
        `approval ${approval.id}`,
      )
      if (!check.ok) return reject(state, asDomainError(check).code, check.message)
      return accept({
        ...state,
        approvals: {
          ...state.approvals,
          [approval.id]: { ...approval, status: event.status, decidedAt: event.at },
        },
      })
    }

    default: {
      const exhaustive: never = event
      return reject(state, 'ILLEGAL_TRANSITION', `未知事件：${JSON.stringify(exhaustive)}`)
    }
  }
}

/** 供属性测试与 Runtime 使用：顺序应用一串事件，遇到拒绝即停止 */
export function applyEvents(
  state: DomainState,
  events: readonly DomainEvent[],
): { state: DomainState; rejected: { index: number; error: DomainError } | null } {
  let current = state
  for (const [index, event] of events.entries()) {
    const outcome = applyEvent(current, event)
    if (!outcome.ok) return { state: current, rejected: { index, error: outcome.error } }
    current = outcome.state
  }
  return { state: current, rejected: null }
}
