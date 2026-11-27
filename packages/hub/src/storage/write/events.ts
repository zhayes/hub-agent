import type { DomainEvent } from '../../domain/events'
import { checkInvariants } from '../../domain/invariants'
import { applyEvent, type DomainState } from '../../domain/machine'
import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import type { Db } from '../db'
import { upsertAggregate } from './projections'

export type EventActor = 'brain' | 'runtime' | 'agent' | 'user' | 'system'

export interface AppendOptions {
  id?: string
  actor?: EventActor
  traceId?: string
}

export interface AppendedEvent {
  seq: number
  id: string
  state: DomainState
}

interface EventMeta {
  at: string
  aggregateType: string
  aggregateId: string
  goalId: string | null
}

/** 事件携带的时间：已发生的取 `at`，创建的取实体 `createdAt` */
function eventMeta(event: DomainEvent, next: DomainState, recordedAt: string): EventMeta {
  switch (event.type) {
    case 'goal.created':
      return {
        at: event.goal.createdAt,
        aggregateType: 'goal',
        aggregateId: event.goal.id,
        goalId: event.goal.id,
      }
    case 'goal.status':
      return {
        at: event.at,
        aggregateType: 'goal',
        aggregateId: event.goalId,
        goalId: event.goalId,
      }
    case 'task.created':
      return {
        at: event.task.createdAt,
        aggregateType: 'task',
        aggregateId: event.task.id,
        goalId: event.task.goalId,
      }
    case 'task.status':
      return {
        at: event.at,
        aggregateType: 'task',
        aggregateId: event.taskId,
        goalId: next.tasks[event.taskId]?.goalId ?? null,
      }
    case 'subtask.created':
      return {
        at: event.subtask.createdAt,
        aggregateType: 'subtask',
        aggregateId: event.subtask.id,
        goalId: next.tasks[event.subtask.taskId]?.goalId ?? null,
      }
    case 'subtask.assigned':
      return {
        at: event.at,
        aggregateType: 'subtask',
        aggregateId: event.subtaskId,
        goalId: goalIdOfSubtask(next, event.subtaskId),
      }
    case 'subtask.status':
      return {
        at: event.at,
        aggregateType: 'subtask',
        aggregateId: event.subtaskId,
        goalId: goalIdOfSubtask(next, event.subtaskId),
      }
    case 'execution.created':
      return {
        at: event.execution.createdAt,
        aggregateType: 'execution',
        aggregateId: event.execution.id,
        goalId: next.tasks[event.execution.taskId]?.goalId ?? null,
      }
    case 'execution.status':
      return {
        at: event.at,
        aggregateType: 'execution',
        aggregateId: event.executionId,
        goalId: goalIdOfExecution(next, event.executionId),
      }
    case 'execution.evidence':
      // 证据事件本身不带时间：用写入时间（审计用，重放时不会被读到）
      return {
        at: recordedAt,
        aggregateType: 'execution',
        aggregateId: event.executionId,
        goalId: goalIdOfExecution(next, event.executionId),
      }
    case 'verification.recorded':
      return {
        at: event.run.createdAt,
        aggregateType: 'verification',
        aggregateId: event.run.id,
        goalId: goalIdOfExecution(next, event.run.executionId),
      }
    case 'approval.requested':
      return {
        at: next.approvals[event.approval.id]?.createdAt ?? recordedAt,
        aggregateType: 'approval',
        aggregateId: event.approval.id,
        goalId: next.tasks[event.approval.taskId]?.goalId ?? null,
      }
    case 'approval.decided':
      return {
        at: event.at,
        aggregateType: 'approval',
        aggregateId: event.approvalId,
        goalId: goalIdOfApproval(next, event.approvalId),
      }
  }
}

function goalIdOfSubtask(state: DomainState, subtaskId: string): string | null {
  const subtask = state.subtasks[subtaskId]
  if (subtask === undefined) return null
  return state.tasks[subtask.taskId]?.goalId ?? null
}

function goalIdOfExecution(state: DomainState, executionId: string): string | null {
  const execution = state.executions[executionId]
  if (execution === undefined) return null
  return state.tasks[execution.taskId]?.goalId ?? null
}

function goalIdOfApproval(state: DomainState, approvalId: string): string | null {
  const approval = state.approvals[approvalId]
  if (approval === undefined) return null
  return state.tasks[approval.taskId]?.goalId ?? null
}

const INSERT_EVENT = `
INSERT INTO events (id, type, aggregate_type, aggregate_id, goal_id, at, actor, payload, trace_id)
VALUES (@id, @type, @aggregateType, @aggregateId, @goalId, @at, @actor, @payload, @traceId)
`

/**
 * 追加一个事件：**单事务**内完成「插事件 + 更新投影 + 推进 last_applied_seq」。
 *
 * 领域拒绝（非法迁移 / 不变量）时抛 HubError，且不写任何行——
 * 这是 M2 的可测性质：被拒绝的追加不产生副作用。
 */
export function appendEvent(
  db: Db,
  state: DomainState,
  event: DomainEvent,
  options: AppendOptions = {},
): AppendedEvent {
  const outcome = applyEvent(state, event)
  if (!outcome.ok) {
    throw new HubError('EVENT_REJECTED', outcome.error.message, {
      code: outcome.error.code,
      details: outcome.error.details,
      eventType: event.type,
    })
  }

  const next = outcome.state

  // 安全网：迁移守卫只能看见单次迁移，看不见“创建时就带错状态”这类组合。
  // 落库前跑一次全量不变量检查（M2 规模 O(n)，可接受）。
  const violations = checkInvariants(next)
  if (violations.length > 0) {
    throw new HubError(
      'EVENT_REJECTED',
      `不变量被破坏：${violations.map((v) => `${v.id} ${v.message}`).join('; ')}`,
      { eventType: event.type, violations },
    )
  }

  const meta = eventMeta(event, next, new Date().toISOString())
  const id = options.id ?? newId()
  const actor = options.actor ?? 'runtime'

  const run = db.transaction((): number => {
    const info = db.prepare(INSERT_EVENT).run({
      id,
      type: event.type,
      aggregateType: meta.aggregateType,
      aggregateId: meta.aggregateId,
      goalId: meta.goalId,
      at: meta.at,
      actor,
      payload: JSON.stringify(event),
      traceId: options.traceId ?? null,
    })

    const seq = Number(info.lastInsertRowid)
    upsertAggregate(db, event, next)
    db.prepare(
      `INSERT INTO projection_meta (key, value) VALUES ('last_applied_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(seq))

    return seq
  })

  return { seq: run(), id, state: next }
}

export function lastSeq(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as
    | { seq: number }
    | undefined
  return row?.seq ?? 0
}

export function eventCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number } | undefined
  return row?.n ?? 0
}
