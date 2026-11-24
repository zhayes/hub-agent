import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedBrain } from '../../src/brain/scripted-brain'
import { buildBrainInput } from '../../src/brain/snapshot'
import { type BrainInput, DEFAULT_BRAIN_BUDGET } from '../../src/brain/types'
import { validateBrainActions } from '../../src/brain/validate'
import { asGoalId, asTimestamp } from '../../src/domain/ids'
import { applyEvent, type DomainState, emptyState } from '../../src/domain/machine'
import { runBrainRound } from '../../src/runtime/brain-loop'
import { answerClarification, createClarification } from '../../src/runtime/clarify'
import {
  claimDecisionPoint,
  completeDecisionPoint,
  enqueueDecisionPoint,
  listDecisionPoints,
} from '../../src/runtime/decision-queue'
import { listDecisions, recordDecision } from '../../src/runtime/decision-record'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

function goalState(): DomainState {
  const at = asTimestamp(new Date().toISOString())
  const outcome = applyEvent(emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('g1'),
      userId: 'local',
      title: '修一个 bug',
      intent: '修一个 bug',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.state
}

function input(state: DomainState): BrainInput {
  return buildBrainInput({
    state,
    goalId: 'g1',
    agents: [{ id: 'a1', name: 'mock', status: 'online' }],
    pending: [],
    budget: DEFAULT_BRAIN_BUDGET,
    stateVersion: 1,
  })
}

describe('Brain 快照与纯函数', () => {
  it('同一快照重复 step/explain 语义等价', async () => {
    const state = goalState()
    const a = input(state)
    const b = input(state)
    expect(a).toEqual(b)

    const brain = new ScriptedBrain()
    const first = await brain.step(a)
    const second = await brain.step(b)
    expect(first).toEqual(second)
    expect(first[0]?.type).toBe('revise_plan')

    const explainA = await brain.explain(a)
    const explainB = await brain.explain(b)
    expect(explainA).toEqual(explainB)
    expect(explainA[0]?.rationale.length).toBeGreaterThan(0)
  })
})

describe('Brain 动作校验', () => {
  it('无计划时给出单子任务计划', async () => {
    const actions = await new ScriptedBrain().step(input(goalState()))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('revise_plan')
  })

  it('未知子任务/未知 Agent 被拒', () => {
    const snapshot = input(goalState())
    const result = validateBrainActions(
      snapshot,
      [
        { type: 'delegate', request: { subtaskId: 'missing', objective: 'x' } },
        { type: 'delegate', request: { subtaskId: 'missing', objective: 'x', agentId: 'nope' } },
      ],
      DEFAULT_BRAIN_BUDGET,
    )
    expect(result.ok).toBe(false)
    expect(result.actions).toHaveLength(0)
  })

  it('动作数超预算直接拒绝', () => {
    const snapshot = input(goalState())
    const actions = Array.from({ length: 17 }, () => ({ type: 'finish', summary: 'x' }))
    const result = validateBrainActions(snapshot, actions, DEFAULT_BRAIN_BUDGET)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('上限')
  })
})

describe('决策队列', () => {
  it('同一 dedupeKey 重复入队只有一行；claim 只派发一次', () => {
    const database = db()
    const first = enqueueDecisionPoint(database, {
      goalId: 'g1',
      reason: 'subtask_terminal',
      dedupeKey: 'g1:subtask:s1',
    })
    const second = enqueueDecisionPoint(database, {
      goalId: 'g1',
      reason: 'subtask_terminal',
      dedupeKey: 'g1:subtask:s1',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(listDecisionPoints(database, 'g1')).toHaveLength(1)

    const claimed = claimDecisionPoint(database, 'g1', 'brain')
    expect(claimed?.status).toBe('claimed')
    expect(claimDecisionPoint(database, 'g1', 'brain')).toBeUndefined()

    completeDecisionPoint(database, claimed?.id ?? '', 'done')
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('done')
  })
})

describe('DecisionRecord 与 Brain 回合', () => {
  it('回合写 DecisionRecord，重复决策点不再派发', async () => {
    const database = db()
    goalState()
    // 把 goal 落到 DB，供 runBrainRound 读快照
    const at = asTimestamp(new Date().toISOString())
    appendEvent(database, emptyState, {
      type: 'goal.created',
      goal: {
        id: asGoalId('g1'),
        userId: 'local',
        title: '修一个 bug',
        intent: '修一个 bug',
        status: 'active',
        createdAt: at,
        updatedAt: at,
      },
    })

    const brain = new ScriptedBrain()
    const first = await runBrainRound({
      db: database,
      brain,
      goalId: 'g1',
      reason: 'plan_invalid',
      dedupeKey: 'g1:initial',
      agents: [{ id: 'a1', name: 'mock', status: 'online' }],
    })
    expect(first?.actions[0]?.type).toBe('revise_plan')
    expect(first?.record.rationale.length).toBeGreaterThan(0)
    expect(listDecisions(database, 'g1')).toHaveLength(1)

    const second = await runBrainRound({
      db: database,
      brain,
      goalId: 'g1',
      reason: 'plan_invalid',
      dedupeKey: 'g1:initial',
      agents: [],
    })
    expect(second).toBeUndefined()
    expect(listDecisions(database, 'g1')).toHaveLength(1)
  })

  it('recordDecision 可直接查询', () => {
    const database = db()
    const record = recordDecision(database, {
      goalId: 'g1',
      type: 'decompose',
      rationale: '测试',
      inputs: { reason: 'test' },
    })
    expect(listDecisions(database, 'g1').map((item) => item.id)).toContain(record.id)
  })
})

describe('clarify：questionId + executionId 路由（TC-018）', () => {
  it('两个并行问题答案不串', () => {
    const database = db()
    const q1 = createClarification(database, {
      goalId: 'g1',
      executionId: 'e1',
      question: '问题一',
    })
    const q2 = createClarification(database, {
      goalId: 'g1',
      executionId: 'e2',
      question: '问题二',
    })

    const a1 = answerClarification(database, {
      questionId: q1.id,
      executionId: 'e1',
      answer: '答案一',
    })
    expect(a1.answer).toBe('答案一')

    expect(() =>
      answerClarification(database, {
        questionId: q2.id,
        executionId: 'e1',
        answer: '串台',
      }),
    ).toThrowError(/不匹配/)

    const a2 = answerClarification(database, {
      questionId: q2.id,
      executionId: 'e2',
      answer: '答案二',
    })
    expect(a2.answer).toBe('答案二')
  })
})
