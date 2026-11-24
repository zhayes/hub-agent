import { afterEach, describe, expect, it } from 'vitest'
import { asAgentId, asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { deriveIdempotencyKey, reserveDelegation } from '../../src/runtime/recovery/idempotency'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function seed(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  const at = asTimestamp(new Date().toISOString())
  let state = appendEvent(db, emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('g1'),
      userId: 'local',
      title: 'goal',
      intent: 'goal',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'task.created',
    task: {
      id: asTaskId('t1'),
      goalId: asGoalId('g1'),
      title: 'task',
      description: 'task',
      status: 'draft',
      priority: 0,
      acceptanceCriteria: [],
      createdAt: at,
      updatedAt: at,
    },
  }).state
  appendEvent(db, state, {
    type: 'subtask.created',
    subtask: {
      id: asSubtaskId('s1'),
      taskId: asTaskId('t1'),
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
    },
  })
  return db
}

describe('idempotency：重复投递只有一个契约', () => {
  it('同一 key 重复 reserve 返回同一契约，created=false', () => {
    const db = seed()
    const key = deriveIdempotencyKey({ goalId: 'g1', subtaskId: 's1', attempt: 1 })
    const first = reserveDelegation(db, {
      subtaskId: 's1',
      idempotencyKey: key,
      executionId: 'e1',
    })
    const second = reserveDelegation(db, {
      subtaskId: 's1',
      idempotencyKey: key,
      executionId: 'e2',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.contract.id).toBe(first.contract.id)
    expect(second.contract.executionId).toBe('e1')

    const count = db.prepare('SELECT COUNT(*) AS n FROM delegation_contracts').get() as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('attempt 变化产生新 key / 新契约', () => {
    const db = seed()
    const k1 = deriveIdempotencyKey({ goalId: 'g1', subtaskId: 's1', attempt: 1 })
    const k2 = deriveIdempotencyKey({ goalId: 'g1', subtaskId: 's1', attempt: 2 })
    expect(k1).not.toBe(k2)
    reserveDelegation(db, { subtaskId: 's1', idempotencyKey: k1 })
    const second = reserveDelegation(db, { subtaskId: 's1', idempotencyKey: k2 })
    expect(second.created).toBe(true)
  })
})
