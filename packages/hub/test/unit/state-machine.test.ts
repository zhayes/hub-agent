import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '../../src/domain/events'
import { asAgentId, asApprovalId, asExecutionId, asGoalId, asSubtaskId } from '../../src/domain/ids'
import { applyEvent, type DomainState, emptyState } from '../../src/domain/machine'
import {
  AT,
  execution,
  fold,
  goal as goalFixture,
  IDS,
  seed,
  subtask,
  task as taskFixture,
} from './domain-fixtures'

function draftTask(): DomainState {
  return fold(emptyState, [
    { type: 'goal.created', goal: goalFixture },
    { type: 'task.created', task: { ...taskFixture, status: 'draft' } },
  ])
}

describe('合法迁移', () => {
  it('seed 走通（goal → task → subtask → execution）', () => {
    const state = seed()
    expect(state.tasks[IDS.task]?.status).toBe('ready')
    expect(Object.keys(state.subtasks)).toHaveLength(2)
    expect(Object.keys(state.executions)).toHaveLength(2)
  })

  it('task: draft → planning', () => {
    const outcome = applyEvent(draftTask(), {
      type: 'task.status',
      taskId: IDS.task,
      to: 'planning',
      at: AT,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.state.tasks[IDS.task]?.status).toBe('planning')
  })

  it('execution: created → starting 记录 startedAt', () => {
    const outcome = applyEvent(seed(), {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'starting',
      at: AT,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.state.executions[IDS.e1]?.startedAt).toBe(AT)
  })
})

describe('非法迁移', () => {
  it('task: draft → completed 被拒', () => {
    const outcome = applyEvent(draftTask(), {
      type: 'task.status',
      taskId: IDS.task,
      to: 'completed',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('ILLEGAL_TRANSITION')
  })

  it('同状态迁移被拒（NOOP）', () => {
    const outcome = applyEvent(seed(), {
      type: 'task.status',
      taskId: IDS.task,
      to: 'ready',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('ILLEGAL_TRANSITION')
  })

  it('终态不可逆：completed → running', () => {
    const completed = fold(seed(), [
      { type: 'task.status', taskId: IDS.task, to: 'canceled', at: AT },
    ])
    const outcome = applyEvent(completed, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'running',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('TERMINAL_STATE')
  })

  it('不存在的 aggregate 返回 NOT_FOUND', () => {
    const outcome = applyEvent(emptyState, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'running',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('NOT_FOUND')
  })

  it('execution.taskId 与 subtask 不一致被拒', () => {
    const state = seed()
    const outcome = applyEvent(state, {
      type: 'execution.created',
      execution: {
        id: 'e9' as never,
        taskId: 't-other' as never,
        subtaskId: IDS.s1,
        agentId: IDS.agent,
        status: 'created',
        attempt: 1,
        createdAt: AT,
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })
})

describe('迁移守卫（不变量前置）', () => {
  it('I1：必需子任务未完成时 task 不得 completed', () => {
    const state = fold(seed(), [{ type: 'task.status', taskId: IDS.task, to: 'running', at: AT }])
    const outcome = applyEvent(state, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'completed',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
    expect(outcome.ok === false && outcome.error.details?.['subtaskIds']).toEqual([IDS.s1, IDS.s2])
  })

  it('I3：没有证据的 execution 不得 succeeded', () => {
    const running = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
    ])
    const outcome = applyEvent(running, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'succeeded',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })

  it('I3：unknown 补上证据后可以收敛为 succeeded', () => {
    const unknown = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'unknown', at: AT },
    ])

    const blocked = applyEvent(unknown, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'succeeded',
      at: AT,
    })
    expect(blocked.ok).toBe(false)

    const withEvidence = fold(unknown, [
      {
        type: 'execution.evidence',
        executionId: IDS.e1,
        evidence: { commitSha: 'deadbeef' },
      },
    ])
    const accepted = applyEvent(withEvidence, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'succeeded',
      at: AT,
    })
    expect(accepted.ok).toBe(true)
  })

  it('I2：没有「成功执行 + 通过验收」的 subtask 不得 succeeded', () => {
    const running = fold(seed(), [
      { type: 'subtask.status', subtaskId: IDS.s1, to: 'assigned', at: AT },
      { type: 'subtask.status', subtaskId: IDS.s1, to: 'running', at: AT },
    ])
    const outcome = applyEvent(running, {
      type: 'subtask.status',
      subtaskId: IDS.s1,
      to: 'succeeded',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })

  it('I2：执行成功但验收未通过（fail）时，subtask 不得 succeeded', () => {
    let state = seed()
    state = fold(state, [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
      {
        type: 'execution.evidence',
        executionId: IDS.e1,
        evidence: { commitSha: 'abc' },
      },
      { type: 'execution.status', executionId: IDS.e1, to: 'succeeded', at: AT },
      {
        type: 'verification.recorded',
        run: {
          id: IDS.v1,
          executionId: IDS.e1,
          checks: [{ checkId: 'c1', kind: 'command', passed: false }],
          verdict: 'fail',
          decidedBy: 'runtime',
          createdAt: AT,
        },
      },
      { type: 'subtask.status', subtaskId: IDS.s1, to: 'assigned', at: AT },
      { type: 'subtask.status', subtaskId: IDS.s1, to: 'running', at: AT },
    ])

    const outcome = applyEvent(state, {
      type: 'subtask.status',
      subtaskId: IDS.s1,
      to: 'succeeded',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
  })

  it('I5：有活跃执行时 task 不得 paused', () => {
    const active = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
      { type: 'task.status', taskId: IDS.task, to: 'running', at: AT },
    ])
    const outcome = applyEvent(active, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'paused',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })

  it('I5：执行已取消后可以 paused', () => {
    const quiet = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'canceled', at: AT },
      { type: 'task.status', taskId: IDS.task, to: 'running', at: AT },
    ])
    const outcome = applyEvent(quiet, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'paused',
      at: AT,
    })
    expect(outcome.ok).toBe(true)
  })

  it('I5（反向）：task 暂停后不得启动执行', () => {
    const paused = fold(seed(), [{ type: 'task.status', taskId: IDS.task, to: 'paused', at: AT }])
    const outcome = applyEvent(paused, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'starting',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })

  it('终态执行不再接受新证据', () => {
    const canceled = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'canceled', at: AT },
    ])
    const outcome = applyEvent(canceled, {
      type: 'execution.evidence',
      executionId: IDS.e1,
      evidence: { commitSha: 'late' },
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('execution paused（保留现场）', () => {
  function running(): DomainState {
    return fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
    ])
  }

  it('running → paused → running 可恢复', () => {
    const paused = applyEvent(running(), {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'paused',
      at: AT,
    })
    expect(paused.ok).toBe(true)
    expect(paused.ok && paused.state.executions[IDS.e1]?.status).toBe('paused')

    const resumed = applyEvent(paused.state, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'running',
      at: AT,
    })
    expect(resumed.ok).toBe(true)
  })

  it('paused 不是终态：可收敛为 canceled / failed / unknown', () => {
    const paused = fold(running(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'paused', at: AT },
    ])
    for (const to of ['canceled', 'failed', 'unknown'] as const) {
      const outcome = applyEvent(paused, {
        type: 'execution.status',
        executionId: IDS.e1,
        to,
        at: AT,
      })
      expect(outcome.ok).toBe(true)
    }
  })

  it('paused 期间仍可补证据（用于 unknown 收敛）', () => {
    const paused = fold(running(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'paused', at: AT },
    ])
    const outcome = applyEvent(paused, {
      type: 'execution.evidence',
      executionId: IDS.e1,
      evidence: { transcriptRef: 'transcripts/e1.log' },
    })
    expect(outcome.ok).toBe(true)
  })

  it('先暂停执行、才能暂停 task；恢复顺序相反', () => {
    const paused = fold(running(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'paused', at: AT },
      { type: 'task.status', taskId: IDS.task, to: 'running', at: AT },
    ])

    const taskPaused = applyEvent(paused, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'paused',
      at: AT,
    })
    expect(taskPaused.ok).toBe(true)

    // task 仍在暂停：不得提前恢复执行
    const tooEarly = applyEvent(taskPaused.state, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'running',
      at: AT,
    })
    expect(tooEarly.ok).toBe(false)

    // 先恢复 task，再恢复执行
    const taskResumed = fold(taskPaused.state, [
      { type: 'task.status', taskId: IDS.task, to: 'running', at: AT },
    ])
    const resumed = applyEvent(taskResumed, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'running',
      at: AT,
    })
    expect(resumed.ok).toBe(true)
  })

  it('paused 的执行必须有证据才能转 succeeded', () => {
    const paused = fold(running(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'paused', at: AT },
    ])
    const blocked = applyEvent(paused, {
      type: 'execution.status',
      executionId: IDS.e1,
      to: 'succeeded',
      at: AT,
    })
    expect(blocked.ok).toBe(false)
  })
})

describe('拒绝不产生副作用', () => {
  it('被拒绝时返回原状态引用（便于断言无写入）', () => {
    const state = seed()
    const outcome = applyEvent(state, {
      type: 'task.status',
      taskId: IDS.task,
      to: 'completed',
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.state).toBe(state)
  })
})

describe('创建事件不得伪造状态（M2 review #2）', () => {
  it('goal.created 只能是 active', () => {
    for (const status of ['paused', 'completed', 'failed', 'canceled'] as const) {
      const outcome = applyEvent(emptyState, {
        type: 'goal.created',
        goal: { ...goalFixture, status },
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
    }
  })

  it('task.created 只能是 draft / ready', () => {
    const base = fold(emptyState, [{ type: 'goal.created', goal: goalFixture }])
    for (const status of ['running', 'completed', 'failed'] as const) {
      const outcome = applyEvent(base, {
        type: 'task.created',
        task: { ...taskFixture, status },
      })
      expect(outcome.ok).toBe(false)
    }
  })

  it('subtask.created 不能一出生就 succeeded（否则 I1 会被绕过）', () => {
    const base = fold(emptyState, [
      { type: 'goal.created', goal: goalFixture },
      { type: 'task.created', task: taskFixture },
    ])
    for (const status of ['succeeded', 'failed', 'running'] as const) {
      const outcome = applyEvent(base, {
        type: 'subtask.created',
        subtask: { ...subtask(IDS.s1, 's'), status },
      })
      expect(outcome.ok).toBe(false)
    }
  })

  it('execution.created 只能是 created（不能带 succeeded 绕过 I3）', () => {
    const base = seed()
    const outcome = applyEvent(base, {
      type: 'execution.created',
      execution: { ...execution(IDS.e1, IDS.s1), id: asExecutionId('e9'), status: 'succeeded' },
    })
    expect(outcome.ok).toBe(false)
  })

  it('approval.requested 只能是 pending（不能直接 approved 绕过审批）', () => {
    const base = seed()
    const outcome = applyEvent(base, {
      type: 'approval.requested',
      approval: {
        id: asApprovalId('a1'),
        taskId: IDS.task,
        action: 'write',
        resource: '/etc/x',
        riskLevel: 'low',
        requestedBy: 'brain',
        reason: 'r',
        status: 'approved',
        createdAt: AT,
      },
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('多 goal（M2 review #4）', () => {
  it('可以先后创建两个 goal', () => {
    const state = fold(emptyState, [
      { type: 'goal.created', goal: goalFixture },
      { type: 'goal.created', goal: { ...goalFixture, id: asGoalId('g2'), title: '第二个' } },
    ])
    expect(Object.keys(state.goals)).toHaveLength(2)
  })

  it('同一个 goalId 重复创建才报 DUPLICATE_ID', () => {
    const state = fold(emptyState, [{ type: 'goal.created', goal: goalFixture }])
    const outcome = applyEvent(state, { type: 'goal.created', goal: goalFixture })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('DUPLICATE_ID')
  })
})

describe('验收结论不得无证据（M2 review #3）', () => {
  function withExecution(): DomainState {
    return seed()
  }

  it('checks 为空时不得判 pass', () => {
    const outcome = applyEvent(withExecution(), {
      type: 'verification.recorded',
      run: {
        id: IDS.v1,
        executionId: IDS.e1,
        checks: [],
        verdict: 'pass',
        decidedBy: 'runtime',
        createdAt: AT,
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe('INVARIANT_BLOCKED')
  })

  it('有检查但未全部通过时不得判 pass', () => {
    const outcome = applyEvent(withExecution(), {
      type: 'verification.recorded',
      run: {
        id: IDS.v1,
        executionId: IDS.e1,
        checks: [
          { checkId: 'c1', kind: 'command', passed: true },
          { checkId: 'c2', kind: 'command', passed: false },
        ],
        verdict: 'pass',
        decidedBy: 'runtime',
        createdAt: AT,
      },
    })
    expect(outcome.ok).toBe(false)
  })

  it('fail / manual_required 不需要全部通过', () => {
    for (const verdict of ['fail', 'manual_required'] as const) {
      const outcome = applyEvent(withExecution(), {
        type: 'verification.recorded',
        run: {
          id: IDS.v1,
          executionId: IDS.e1,
          checks: [],
          verdict,
          decidedBy: 'runtime',
          createdAt: AT,
        },
      })
      expect(outcome.ok).toBe(true)
    }
  })

  it('全部通过时 pass 被接受', () => {
    const outcome = applyEvent(withExecution(), {
      type: 'verification.recorded',
      run: {
        id: IDS.v1,
        executionId: IDS.e1,
        checks: [{ checkId: 'c1', kind: 'command', passed: true }],
        verdict: 'pass',
        decidedBy: 'runtime',
        createdAt: AT,
      },
    })
    expect(outcome.ok).toBe(true)
  })
})

describe('applyEvent 是全函数', () => {
  it('任何事件都不抛异常', () => {
    const events: DomainEvent[] = [
      { type: 'goal.status', goalId: IDS.goal, to: 'completed', at: AT },
      { type: 'subtask.status', subtaskId: IDS.s2, to: 'skipped', at: AT },
      { type: 'approval.decided', approvalId: 'a-missing' as never, status: 'approved', at: AT },
    ]
    for (const event of events) {
      expect(() => applyEvent(seed(), event)).not.toThrow()
    }
  })
})

describe('subtask.assigned', () => {
  it('把实际派单的 Agent 写回子任务，不改状态', () => {
    const state = seed()
    const before = state.subtasks[IDS.s1]
    const outcome = applyEvent(state, {
      type: 'subtask.assigned',
      subtaskId: IDS.s1,
      agentId: asAgentId('agent-real'),
      at: AT,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.state.subtasks[IDS.s1]?.assignedAgentId).toBe('agent-real')
    expect(outcome.state.subtasks[IDS.s1]?.status).toBe(before?.status)
  })

  it('子任务不存在时拒绝', () => {
    const outcome = applyEvent(seed(), {
      type: 'subtask.assigned',
      subtaskId: asSubtaskId('missing'),
      agentId: asAgentId('a'),
      at: AT,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('NOT_FOUND')
  })
})
