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
import { claimDispatch, enqueueDispatch, listDispatches } from '../../src/runtime/dispatch/queue'
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

  it('置 unknown 与建决策点同一事务：中断则整体回滚，重扫能补上', () => {
    const { db, ids } = seed()
    /* 在写入决策点的那一刻注入失败，模拟崩在“置 unknown”与“建决策点”之间。 */
    db.exec(`
      CREATE TRIGGER fail_decision_insert BEFORE INSERT ON decision_queue
      BEGIN SELECT RAISE(ABORT, 'injected crash'); END;
    `)

    expect(() => scanRecovery(db)).toThrow()

    /* 关键：不能只把 Execution 置成 unknown 却留下无人处理的决策点缺口。 */
    const execution = db
      .prepare('SELECT status FROM executions WHERE id = ?')
      .get(ids.executionId) as { status: string }
    expect(execution.status).toBe('running')
    const queued = db.prepare('SELECT COUNT(*) AS n FROM decision_queue').get() as { n: number }
    expect(queued.n).toBe(0)

    /* 故障消失后重扫，恢复流程仍能完整走完。 */
    db.exec('DROP TRIGGER fail_decision_insert')
    const report = scanRecovery(db)
    expect(report.unknown).toEqual([ids.executionId])
    expect(report.decisions).toHaveLength(1)
    const after = db.prepare('SELECT status FROM executions WHERE id = ?').get(ids.executionId) as {
      status: string
    }
    expect(after.status).toBe('unknown')
  })

  it('启动扫描同时回收过期的派发意图', () => {
    const { db } = seed()
    enqueueDispatch(db, {
      goalId: 'g1',
      taskId: 't1',
      subtaskId: 's1',
      target: 'local-acp',
      objective: '改一个文件',
      idempotencyKey: 'g1:s1:1',
    })
    /* 领了但没收尾（模拟进程在派发途中崩掉），且早已超过租约。 */
    claimDispatch(db, { goalId: 'g1', claimedBy: 'runner', now: new Date('2020-01-01T00:00:00Z') })

    const report = scanRecovery(db)
    expect(report.reclaimedDispatches).toHaveLength(1)
    expect(listDispatches(db, 'g1')[0]?.status).toBe('pending')
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
