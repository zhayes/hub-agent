import { afterEach, describe, expect, it } from 'vitest'
import type { Approval, Execution, Goal, Subtask, Task } from '../../src/domain/entities'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { type DomainState, emptyState } from '../../src/domain/machine'
import {
  createSandboxDeniedApproval,
  decideApproval,
  listApprovals,
} from '../../src/runtime/approval'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { getTaskEvidence } from '../../src/storage/queries/evidence'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function seed(): { db: Db; approval: Approval; state: DomainState } {
  const db = openDatabase(':memory:')
  dbs.push(db)
  migrate(db)
  const at = asTimestamp(new Date().toISOString())
  const goal: Goal = {
    id: asGoalId('g1'),
    userId: 'local',
    title: 'goal',
    intent: 'goal',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const task: Task = {
    id: asTaskId('t1'),
    goalId: goal.id,
    title: 'task',
    description: 'task',
    status: 'draft',
    priority: 0,
    acceptanceCriteria: [],
    createdAt: at,
    updatedAt: at,
  }
  const subtask: Subtask = {
    id: asSubtaskId('s1'),
    taskId: task.id,
    title: 'subtask',
    description: 'subtask',
    status: 'ready',
    required: true,
    dependencies: [],
    requiredCapabilities: [],
    assignedAgentId: asAgentId('a1'),
    priority: 0,
    maxAttempts: 1,
    createdAt: at,
    updatedAt: at,
  }
  const execution: Execution = {
    id: asExecutionId('e1'),
    taskId: task.id,
    subtaskId: subtask.id,
    agentId: asAgentId('a1'),
    status: 'created',
    attempt: 1,
    createdAt: at,
  }
  let state = emptyState
  for (const event of [
    { type: 'goal.created' as const, goal },
    { type: 'task.created' as const, task },
    { type: 'subtask.created' as const, subtask },
    { type: 'execution.created' as const, execution },
  ]) {
    state = appendEvent(db, state, event).state
  }
  const approval = createSandboxDeniedApproval({
    taskId: task.id,
    executionId: execution.id,
    agentId: execution.agentId,
    source: 'verify: exit 1',
    text: 'Operation not permitted',
  })
  state = appendEvent(db, state, { type: 'approval.requested', approval }).state
  return { db, approval, state }
}

describe('Approval：sandbox_denied', () => {
  it('创建 pending Approval，字段符合 PRD 命名空间', () => {
    const { approval } = seed()
    expect(approval.reason).toBe('sandbox_denied')
    expect(approval.status).toBe('pending')
    expect(approval.decisionMode).toBe('once')
    expect(approval.requestedBy).toBe('runtime')
    expect(approval.expiresAt).toBeTruthy()
  })

  it('approve 后状态收敛，重复决定被拒', () => {
    const { db, approval } = seed()
    const state = decideApproval(db, approval.id, 'approved')
    expect(state.approvals[approval.id]?.status).toBe('approved')
    expect(state.approvals[approval.id]?.decidedAt).toBeTruthy()

    expect(() => decideApproval(db, approval.id, 'rejected')).toThrowError(/不是 pending/)
  })

  it('listApprovals 与 getTaskEvidence 能读到审批与执行', () => {
    const { db, approval } = seed()
    expect(listApprovals(db).map((item) => item.id)).toContain(approval.id)

    const view = getTaskEvidence(db, 't1')
    expect(view?.task.id).toBe('t1')
    expect(view?.executions).toHaveLength(1)
    expect(view?.approvals.map((item) => item.id)).toContain(approval.id)
  })
})
