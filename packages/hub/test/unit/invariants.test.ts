import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '../../src/domain/events'
import { asVerificationRunId } from '../../src/domain/ids'
import { checkInvariants } from '../../src/domain/invariants'
import { applyEvent, type DomainState } from '../../src/domain/machine'
import {
  EXECUTION_STATUSES,
  type ExecutionStatus,
  SUBTASK_STATUSES,
  type SubtaskStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '../../src/domain/status'
import { AT, fold, happyPath, IDS, seed } from './domain-fixtures'

function replaceSubtask(
  state: DomainState,
  id: string,
  patch: Record<string, unknown>,
): DomainState {
  const target = state.subtasks[id]
  if (target === undefined) throw new Error(`fixture missing subtask ${id}`)
  return { ...state, subtasks: { ...state.subtasks, [id]: { ...target, ...patch } as never } }
}

function replaceExecution(
  state: DomainState,
  id: string,
  patch: Record<string, unknown>,
): DomainState {
  const target = state.executions[id]
  if (target === undefined) throw new Error(`fixture missing execution ${id}`)
  return { ...state, executions: { ...state.executions, [id]: { ...target, ...patch } as never } }
}

function replaceTask(state: DomainState, id: string, patch: Record<string, unknown>): DomainState {
  const target = state.tasks[id]
  if (target === undefined) throw new Error(`fixture missing task ${id}`)
  return { ...state, tasks: { ...state.tasks, [id]: { ...target, ...patch } as never } }
}

describe('不变量：合法状态无违规', () => {
  it('seed 无违规', () => {
    expect(checkInvariants(seed())).toEqual([])
  })

  it('happy path（task completed）无违规', () => {
    expect(checkInvariants(happyPath())).toEqual([])
  })
})

describe('不变量：能抓到被破坏的状态', () => {
  it('I1：task completed 但有未收敛子任务', () => {
    const broken = replaceSubtask(happyPath(), IDS.s2, { status: 'failed' })
    const ids = checkInvariants(broken).map((violation) => violation.id)
    expect(ids).toContain('I1')
  })

  it('I2：subtask succeeded 但没有验收记录', () => {
    const broken: DomainState = { ...happyPath(), verifications: {} }
    const ids = checkInvariants(broken).map((violation) => violation.id)
    expect(ids).toContain('I2')
  })

  it('I3：execution succeeded 但没有证据', () => {
    const broken = replaceExecution(happyPath(), IDS.e1, { evidence: undefined })
    const ids = checkInvariants(broken).map((violation) => violation.id)
    expect(ids).toContain('I3')
  })

  it('I5：task paused 但仍有活跃执行', () => {
    let state = replaceTask(seed(), IDS.task, { status: 'paused' })
    state = replaceExecution(state, IDS.e1, { status: 'running' })
    const ids = checkInvariants(state).map((violation) => violation.id)
    expect(ids).toContain('I5')
  })

  it('I5：task 与 execution 同时 paused 不违规（paused 不算 active）', () => {
    let state = fold(seed(), [
      { type: 'execution.status', executionId: IDS.e1, to: 'starting', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT },
      { type: 'execution.status', executionId: IDS.e1, to: 'paused', at: AT },
      { type: 'task.status', taskId: IDS.task, to: 'paused', at: AT },
    ])
    expect(checkInvariants(state)).toEqual([])

    // 反向验证：若执行被直接置为 running，就必须被 I5 抓到
    state = fold(state, [{ type: 'task.status', taskId: IDS.task, to: 'running', at: AT }])
    state = fold(state, [{ type: 'execution.status', executionId: IDS.e1, to: 'running', at: AT }])
    const broken = replaceTask(state, IDS.task, { status: 'paused' })
    expect(checkInvariants(broken).map((violation) => violation.id)).toContain('I5')
  })

  it('违规记录里带可定位的 refs', () => {
    const broken = replaceExecution(happyPath(), IDS.e1, { evidence: undefined })
    const violation = checkInvariants(broken).find((item) => item.id === 'I3')
    expect(violation?.refs).toContain(IDS.e1)
  })
})

describe('属性测试：随机事件序列', () => {
  type Cmd =
    | { k: 'task'; to: TaskStatus }
    | { k: 'sub1'; to: SubtaskStatus }
    | { k: 'sub2'; to: SubtaskStatus }
    | { k: 'ex1'; to: ExecutionStatus }
    | { k: 'ex2'; to: ExecutionStatus }
    | { k: 'ev1' }
    | { k: 'ev2' }
    | { k: 'ver1'; verdict: 'pass' | 'fail' | 'manual_required' }
    | { k: 'ver2'; verdict: 'pass' | 'fail' | 'manual_required' }

  const verdictArb = fc.constantFrom<'pass' | 'fail' | 'manual_required'>(
    'pass',
    'fail',
    'manual_required',
  )

  const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ k: fc.constant<'task'>('task'), to: fc.constantFrom(...TASK_STATUSES) }),
    fc.record({ k: fc.constant<'sub1'>('sub1'), to: fc.constantFrom(...SUBTASK_STATUSES) }),
    fc.record({ k: fc.constant<'sub2'>('sub2'), to: fc.constantFrom(...SUBTASK_STATUSES) }),
    fc.record({ k: fc.constant<'ex1'>('ex1'), to: fc.constantFrom(...EXECUTION_STATUSES) }),
    fc.record({ k: fc.constant<'ex2'>('ex2'), to: fc.constantFrom(...EXECUTION_STATUSES) }),
    fc.record({ k: fc.constant<'ev1'>('ev1') }),
    fc.record({ k: fc.constant<'ev2'>('ev2') }),
    fc.record({ k: fc.constant<'ver1'>('ver1'), verdict: verdictArb }),
    fc.record({ k: fc.constant<'ver2'>('ver2'), verdict: verdictArb }),
  )

  function toEvent(cmd: Cmd, index: number): DomainEvent {
    switch (cmd.k) {
      case 'task':
        return { type: 'task.status', taskId: IDS.task, to: cmd.to, at: AT }
      case 'sub1':
        return { type: 'subtask.status', subtaskId: IDS.s1, to: cmd.to, at: AT }
      case 'sub2':
        return { type: 'subtask.status', subtaskId: IDS.s2, to: cmd.to, at: AT }
      case 'ex1':
        return { type: 'execution.status', executionId: IDS.e1, to: cmd.to, at: AT }
      case 'ex2':
        return { type: 'execution.status', executionId: IDS.e2, to: cmd.to, at: AT }
      case 'ev1':
        return {
          type: 'execution.evidence',
          executionId: IDS.e1,
          evidence: { commitSha: `sha-${index}`, changedFiles: ['utils.ts'] },
        }
      case 'ev2':
        return {
          type: 'execution.evidence',
          executionId: IDS.e2,
          evidence: { diffstat: `${index} file changed` },
        }
      case 'ver1':
      case 'ver2': {
        const executionId = cmd.k === 'ver1' ? IDS.e1 : IDS.e2
        return {
          type: 'verification.recorded',
          run: {
            id: asVerificationRunId(`vr-${index}`),
            executionId,
            checks: [{ checkId: 'c1', kind: 'command', passed: cmd.verdict !== 'fail' }],
            verdict: cmd.verdict,
            decidedBy: 'runtime',
            createdAt: AT,
          },
        }
      }
    }
  }

  it('1000 组随机序列：接受则不变成立，拒绝则状态不变', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 40 }), (cmds) => {
        let state = seed()

        for (const [index, cmd] of cmds.entries()) {
          const before = state
          const outcome = applyEvent(state, toEvent(cmd, index))

          if (outcome.ok) {
            state = outcome.state
            const violations = checkInvariants(state)
            expect(violations).toEqual([])
          } else {
            expect(outcome.state).toBe(before)
          }
        }

        return true
      }),
      { numRuns: 1000 },
    )
  })
})
