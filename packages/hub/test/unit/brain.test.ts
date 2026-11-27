import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedBrain } from '../../src/brain/scripted-brain'
import { buildBrainInput } from '../../src/brain/snapshot'
import {
  type BrainInput,
  DEFAULT_BRAIN_BUDGET,
  type OrchestratorBrain,
} from '../../src/brain/types'
import { validateBrainActions } from '../../src/brain/validate'
import { asGoalId, asSessionId, asTimestamp } from '../../src/domain/ids'
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
import { IDS, seed } from './domain-fixtures'

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

    completeDecisionPoint(database, claimed?.id ?? '', 'done', {
      claimToken: claimed?.claimToken ?? '',
    })
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

describe('Brain 回合：explain 超时（P0）', () => {
  it('explain 永不返回时，回合仍能在预算内收尾，不会把 claim 占死', async () => {
    const database = db()
    const at = asTimestamp(new Date().toISOString())
    appendEvent(database, emptyState, {
      type: 'goal.created',
      goal: {
        id: asGoalId('g1'),
        userId: 'local',
        title: '超时目标',
        intent: '超时目标',
        status: 'active',
        createdAt: at,
        updatedAt: at,
      },
    })

    const base = new ScriptedBrain()
    const brain: OrchestratorBrain = {
      step: (input) => base.step(input),
      explain: () => new Promise<never>(() => {}),
    }

    const started = Date.now()
    const round = await runBrainRound({
      db: database,
      brain,
      goalId: 'g1',
      reason: 'plan_invalid',
      dedupeKey: 'g1:explain-timeout',
      agents: [],
      budget: { ...DEFAULT_BRAIN_BUDGET, timeoutMs: 50 },
    })

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(round?.actions[0]?.type).toBe('revise_plan')
    expect(round?.record.rationale.length).toBeGreaterThan(0)

    /* 关键：claim 已收尾，不会因为 explain 挂住而永久停留在 claimed。 */
    const [point] = listDecisionPoints(database, 'g1')
    expect(point?.status).toBe('done')
  })
})

describe('Brain 快照：会话工作区', () => {
  it('传了 workspace 就写进快照，没传就不出现该字段', () => {
    const state = goalState()
    const withWorkspace = buildBrainInput({
      state,
      goalId: 'g1',
      agents: [],
      pending: [],
      budget: DEFAULT_BRAIN_BUDGET,
      stateVersion: 1,
      workspace: '/Users/me/adstudio',
    })
    expect(withWorkspace.workspace).toEqual({ path: '/Users/me/adstudio' })

    expect(input(state).workspace).toBeUndefined()
  })
})

describe('Brain 快照：执行证据', () => {
  it('带上 Agent 最终回答与会话标识，并按预算截断', () => {
    const base = seed()
    const longResult = 'r'.repeat(5_000)
    const original = base.executions[IDS.e1]
    if (original === undefined) throw new Error('fixture 缺少 execution')
    const state = {
      ...base,
      executions: {
        ...base.executions,
        [IDS.e1]: {
          ...original,
          sessionId: asSessionId('sess-1'),
          evidence: { result: longResult, transcriptRef: 'transcript.jsonl' },
        },
      },
    }

    const snapshot = buildBrainInput({
      state,
      goalId: IDS.goal,
      agents: [],
      pending: [],
      budget: DEFAULT_BRAIN_BUDGET,
      stateVersion: 1,
    })

    const execution = snapshot.tasks
      .flatMap((task) => task.subtasks)
      .find((subtask) => subtask.id === IDS.s1)?.execution
    expect(execution?.sessionId).toBe('sess-1')
    /* 4000 字上限 + 截断标记，避免把上下文预算吃光 */
    expect(execution?.evidence?.result?.length).toBeLessThan(4_200)
    expect(execution?.evidence?.result).toContain('已截断')
    expect(execution?.evidence?.resultTruncated).toBe(true)
    expect(execution?.evidence?.transcriptRef).toBe('transcript.jsonl')
  })
})
