import type { VerificationCheckResult } from '../domain/entities'
import { asExecutionId, asTimestamp, asVerificationRunId } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { enqueueDecisionPoint } from './decision-queue'

/**
 * 人工验收（PRD §7.7 / §6.7.5）。
 *
 * 远端交付物或确定性检查无法自动判定时，执行会停在 `waiting_input`。
 * 这里提供**人类决策**这一条收敛路径：接受 → 记一条 `decidedBy='human'` 的验收记录并置成功；
 * 拒绝 → 置失败，交回 Brain 重规划。
 *
 * 为什么不是“改一下 verdict 就完事”：
 * - `VerificationRun` 是验收真相，所以人工决定也写成一条记录（可审计、可回溯是谁定的）；
 * - 状态机不允许 `waiting_input → succeeded` 直跳，必须经 `running`（见 `domain/status`）；
 * - 收敛后必须产生下一个决策点，否则 Brain 永远不知道可以继续（§5.1 的唤醒语义）。
 */

export interface AcceptanceResult {
  goalId: string
  taskId: string
  subtaskId: string
  executionId: string
  decisionPointId: string
  verdict: 'pass' | 'fail'
}

export interface AcceptExecutionInput {
  executionId: string
  /** 人工说明（写进验收记录，便于事后回答“凭什么接受”）。 */
  note?: string
}

export interface RejectExecutionInput {
  executionId: string
  reason: string
}

export function acceptExecution(db: Db, input: AcceptExecutionInput): AcceptanceResult {
  return decideExecution(db, {
    executionId: input.executionId,
    accept: true,
    ...(input.note === undefined ? {} : { note: input.note }),
  })
}

export function rejectExecution(db: Db, input: RejectExecutionInput): AcceptanceResult {
  return decideExecution(db, {
    executionId: input.executionId,
    accept: false,
    note: input.reason,
  })
}

function decideExecution(
  db: Db,
  input: { executionId: string; accept: boolean; note?: string },
): AcceptanceResult {
  const execId = asExecutionId(input.executionId)

  return db.transaction((): AcceptanceResult => {
    let state = loadState(db)
    const execution = state.executions[execId]
    if (execution === undefined) {
      throw new HubError('NOT_FOUND', `执行不存在：${input.executionId}`, {
        executionId: input.executionId,
      })
    }
    /* 只有“等人工”的执行可以被人接受/拒绝；别把运行中的执行直接判成功。 */
    if (execution.status !== 'waiting_input') {
      throw new HubError('EVENT_REJECTED', `执行不在等待人工验收状态：${execution.status}`, {
        executionId: input.executionId,
        status: execution.status,
      })
    }

    const task = state.tasks[execution.taskId]
    const subtask = state.subtasks[execution.subtaskId]
    if (task === undefined || subtask === undefined) {
      throw new HubError('DB_UNAVAILABLE', '执行关联的 task/subtask 缺失', {
        executionId: input.executionId,
      })
    }

    const now = asTimestamp(new Date().toISOString())
    const verdict = input.accept ? 'pass' : 'fail'
    const check: VerificationCheckResult = {
      checkId: 'human-decision',
      kind: 'llmReview',
      passed: input.accept,
      outputRef: `human:${input.accept ? 'accept' : 'reject'}@${now}`,
    }

    state = appendEvent(db, state, {
      type: 'verification.recorded',
      run: {
        id: asVerificationRunId(newId()),
        executionId: execId,
        checks: [check],
        verdict,
        decidedBy: 'human',
        createdAt: now,
      },
    }).state

    /* 不变量：succeeded 必须有证据。没有远端证据时，以人工作出的依据充当证据；
       已有远端证据（a2a:<peer>/<task>）则保留，不覆盖。 */
    if (execution.evidence === undefined) {
      state = appendEvent(db, state, {
        type: 'execution.evidence',
        executionId: execId,
        evidence: {
          transcriptRef: `human:${input.accept ? 'accept' : 'reject'}@${now}`,
          ...(input.note === undefined ? {} : { diffstat: input.note.slice(0, 2000) }),
        },
      }).state
    }

    /* waiting_input → running → 终态：状态机不允许直跳（domain/status）。 */
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: execId,
      to: 'running',
      at: now,
    }).state
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: execId,
      to: input.accept ? 'succeeded' : 'failed',
      at: now,
    }).state

    state = appendEvent(db, state, {
      type: 'subtask.status',
      subtaskId: execution.subtaskId,
      to: 'running',
      at: now,
    }).state
    state = appendEvent(db, state, {
      type: 'subtask.status',
      subtaskId: execution.subtaskId,
      to: input.accept ? 'succeeded' : 'failed',
      at: now,
    }).state

    /* 接受后 Task 回到 running，让 Brain 决定下一步；拒绝则收敛为 failed 交给重规划。 */
    state = appendEvent(db, state, {
      type: 'task.status',
      taskId: execution.taskId,
      to: input.accept ? 'running' : 'failed',
      at: now,
    }).state

    const { point } = enqueueDecisionPoint(db, {
      goalId: task.goalId,
      reason: input.accept ? 'human_accepted' : 'human_rejected',
      dedupeKey: `human:${execution.id}:${input.accept ? 'accept' : 'reject'}`,
      payload: {
        executionId: execution.id,
        verdict,
        decidedBy: 'human',
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    })

    return {
      goalId: task.goalId,
      taskId: execution.taskId,
      subtaskId: execution.subtaskId,
      executionId: execution.id,
      decisionPointId: point.id,
      verdict,
    }
  })()
}
