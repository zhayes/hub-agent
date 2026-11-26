import { afterEach, describe, expect, it } from 'vitest'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { detectNoProgress } from '../../src/runtime/recovery/no-progress'
import { pauseTask, resumeTask } from '../../src/runtime/recovery/pause'
import { scanRecovery } from '../../src/runtime/recovery/scan'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

interface Seeded {
  db: Db
  ids: { goalId: string; taskId: string; subtaskId: string; executionId: string }
}

type ExecutionStep = 'starting' | 'running' | 'waiting_input'

function seed(executionPath: readonly ExecutionStep[] = ['starting', 'running']): Seeded {
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
  state = appendEvent(db, state, {
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
  }).state
  state = appendEvent(db, state, {
    type: 'execution.created',
    execution: {
      id: asExecutionId('e1'),
      taskId: asTaskId('t1'),
      subtaskId: asSubtaskId('s1'),
      agentId: asAgentId('a1'),
      status: 'created',
      attempt: 1,
      createdAt: at,
    },
  }).state
  for (const to of ['planning', 'ready', 'running'] as const) {
    state = appendEvent(db, state, {
      type: 'task.status',
      taskId: asTaskId('t1'),
      to,
      at: asTimestamp(new Date().toISOString()),
    }).state
  }
  state = appendEvent(db, state, {
    type: 'subtask.status',
    subtaskId: asSubtaskId('s1'),
    to: 'assigned',
    at: asTimestamp(new Date().toISOString()),
  }).state
  state = appendEvent(db, state, {
    type: 'subtask.status',
    subtaskId: asSubtaskId('s1'),
    to: 'running',
    at: asTimestamp(new Date().toISOString()),
  }).state
  for (const to of executionPath) {
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: asExecutionId('e1'),
      to,
      at: asTimestamp(new Date().toISOString()),
    }).state
  }
  return {
    db,
    ids: { goalId: 'g1', taskId: 't1', subtaskId: 's1', executionId: 'e1' },
  }
}

describe('recovery：重启扫描', () => {
  it('进程不在的 running Execution → unknown + 决策点；重复扫描不重复', () => {
    const { db, ids } = seed()
    const first = scanRecovery(db)
    expect(first.unknown).toEqual([ids.executionId])
    expect(first.decisions).toHaveLength(1)

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(ids.executionId) as { status: string }
    expect(execution.status).toBe('unknown')

    const second = scanRecovery(db)
    expect(second.unknown).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM decision_queue').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('进程仍存活则跳过', () => {
    const { db } = seed()
    const report = scanRecovery(db, { isProcessAlive: () => true })
    expect(report.unknown).toEqual([])
    expect(report.skippedAlive).toHaveLength(1)
  })

  it('waiting_input 停在原地，不被强转 unknown', () => {
    const { db, ids } = seed(['starting', 'running', 'waiting_input'])
    const report = scanRecovery(db)

    expect(report.unknown).toEqual([])
    expect(report.skippedIncomplete).toEqual([ids.executionId])

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(ids.executionId) as { status: string }
    expect(execution.status).toBe('waiting_input')

    const decisions = db.prepare('SELECT COUNT(*) AS n FROM decision_queue').get() as { n: number }
    expect(decisions.n).toBe(0)
  })

  it('starting 不收敛为 unknown，保持原状交下次启动', () => {
    const { db, ids } = seed(['starting'])
    const report = scanRecovery(db)

    expect(report.unknown).toEqual([])
    expect(report.skippedIncomplete).toEqual([ids.executionId])

    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(ids.executionId) as { status: string }
    expect(execution.status).toBe('starting')
  })
})

describe('recovery：暂停/恢复', () => {
  it('暂停顺序：Execution → Subtask → Task；恢复顺序相反', () => {
    const { db, ids } = seed()
    const paused = pauseTask(db, ids.taskId, 'no_progress')
    expect(paused.executions).toEqual([ids.executionId])
    expect(paused.subtasks).toEqual([ids.subtaskId])

    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(ids.taskId) as {
      status: string
    }
    expect(task.status).toBe('paused')
    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(ids.executionId) as { status: string }
    expect(execution.status).toBe('paused')

    const resumed = resumeTask(db, ids.taskId)
    expect(resumed.executions).toEqual([ids.executionId])
    expect(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get(ids.taskId) as { status: string })
        .status,
    ).toBe('running')
  })

  it('无进展检测命中后暂停任务', () => {
    const { db, ids } = seed()
    const detection = detectNoProgress({
      nowMs: 1_000_000,
      lastEventAtMs: 800_000,
      planHashes: ['p', 'p'],
      diffHashes: [],
      toolCalls: [],
      budgetUsed: 0,
      budgetLimit: 100,
    })
    expect(detection.stuck).toBe(true)
    pauseTask(db, ids.taskId, detection.reasons.join('; '))
    expect(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get(ids.taskId) as { status: string })
        .status,
    ).toBe('paused')
  })
})
