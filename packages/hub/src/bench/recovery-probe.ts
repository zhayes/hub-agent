import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../domain/ids'
import { emptyState } from '../domain/machine'
import { scanRecovery } from '../runtime/recovery/scan'
import { openDatabase } from '../storage/db'
import { migrate } from '../storage/migrate'
import { appendEvent } from '../storage/write/events'

export interface RecoveryProbe {
  ok: boolean
  unknown: number
  decisions: number
}

/** 确定性恢复探针：seed 一个 running Execution，验证重启扫描收敛 unknown + 决策点。 */
export function runRecoveryProbe(): RecoveryProbe {
  const db = openDatabase(':memory:')
  try {
    migrate(db)
    const at = asTimestamp(new Date().toISOString())
    let state = appendEvent(db, emptyState, {
      type: 'goal.created',
      goal: {
        id: asGoalId('probe-goal'),
        userId: 'local',
        title: 'recovery probe',
        intent: 'recovery probe',
        status: 'active',
        createdAt: at,
        updatedAt: at,
      },
    }).state
    state = appendEvent(db, state, {
      type: 'task.created',
      task: {
        id: asTaskId('probe-task'),
        goalId: asGoalId('probe-goal'),
        title: 'recovery probe',
        description: 'recovery probe',
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
        id: asSubtaskId('probe-subtask'),
        taskId: asTaskId('probe-task'),
        title: 'recovery probe',
        description: 'recovery probe',
        status: 'ready',
        required: true,
        dependencies: [],
        requiredCapabilities: [],
        assignedAgentId: asAgentId('probe-agent'),
        priority: 0,
        maxAttempts: 1,
        createdAt: at,
        updatedAt: at,
      },
    }).state
    state = appendEvent(db, state, {
      type: 'execution.created',
      execution: {
        id: asExecutionId('probe-execution'),
        taskId: asTaskId('probe-task'),
        subtaskId: asSubtaskId('probe-subtask'),
        agentId: asAgentId('probe-agent'),
        status: 'created',
        attempt: 1,
        createdAt: at,
      },
    }).state
    for (const to of ['planning', 'ready', 'running'] as const) {
      state = appendEvent(db, state, {
        type: 'task.status',
        taskId: asTaskId('probe-task'),
        to,
        at: asTimestamp(new Date().toISOString()),
      }).state
    }
    for (const to of ['assigned', 'running'] as const) {
      state = appendEvent(db, state, {
        type: 'subtask.status',
        subtaskId: asSubtaskId('probe-subtask'),
        to,
        at: asTimestamp(new Date().toISOString()),
      }).state
    }
    for (const to of ['starting', 'running'] as const) {
      state = appendEvent(db, state, {
        type: 'execution.status',
        executionId: asExecutionId('probe-execution'),
        to,
        at: asTimestamp(new Date().toISOString()),
      }).state
    }
    const report = scanRecovery(db)
    return {
      ok: report.unknown.length === 1 && report.decisions.length === 1,
      unknown: report.unknown.length,
      decisions: report.decisions.length,
    }
  } finally {
    db.close()
  }
}
