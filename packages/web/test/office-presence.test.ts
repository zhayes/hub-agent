import { describe, expect, it } from 'vitest'
import type { ScenePhase } from '../src/features/agents/office/contracts'
import {
  allocateSeats,
  attentionAgents,
  needsAttention,
  occupiesDesk,
  phaseOf,
} from '../src/features/agents/office/presence'
import type { AgentPresence, PresenceState } from '../src/shared/api'

function agent(overrides: Partial<AgentPresence> & { id?: string } = {}): AgentPresence {
  return {
    id: overrides.id ?? 'a1',
    name: 'Agent',
    status: 'online',
    presence: 'online',
    networkMode: 'agent-managed',
    allowedWrite: [],
    allowedDomains: [],
    capabilities: [],
    parallelCount: 0,
    pendingApprovals: [],
    ...overrides,
  }
}

function busy(
  waitingOn: 'permission' | 'input' | null,
  executionStatus = 'running',
): AgentPresence {
  return agent({
    presence: 'busy',
    activity: {
      executionId: 'e1',
      executionStatus,
      taskId: 't1',
      taskTitle: 'Task',
      subtaskId: 's1',
      subtaskTitle: 'Subtask',
      attempt: 1,
      waitingOn,
    },
  })
}

describe('phaseOf — §2.2 状态映射逐行', () => {
  const rows: Array<[PresenceState, ScenePhase]> = [
    ['discovered', 'off-floor'],
    ['offline', 'off-floor'],
    ['disabled', 'off-floor'],
    ['error', 'failed'],
    ['degraded', 'degraded'],
    ['starting', 'entering'],
    ['initializing', 'entering'],
  ]
  for (const [presence, phase] of rows) {
    it(`presence=${presence} → ${phase}`, () => {
      expect(phaseOf(agent({ presence }))).toBe(phase)
    })
  }

  it('busy + waitingOn=permission → needs-approval', () => {
    expect(phaseOf(busy('permission'))).toBe('needs-approval')
  })

  it('busy + waitingOn=input → needs-input', () => {
    expect(phaseOf(busy('input'))).toBe('needs-input')
  })

  it('busy + running → working', () => {
    expect(phaseOf(busy(null, 'running'))).toBe('working')
  })

  it('online + paused execution → paused', () => {
    const paused = agent({
      presence: 'online',
      activity: {
        executionId: 'e1',
        executionStatus: 'paused',
        taskId: 't1',
        taskTitle: 'Task',
        subtaskId: 's1',
        subtaskTitle: 'Subtask',
        attempt: 1,
        waitingOn: null,
      },
    })
    expect(phaseOf(paused)).toBe('paused')
  })

  it('online 且无执行 → standby', () => {
    expect(phaseOf(agent({ presence: 'online' }))).toBe('standby')
  })

  it('未知 presence 不猜 → off-floor', () => {
    expect(phaseOf(agent({ presence: 'bogus' as PresenceState }))).toBe('off-floor')
  })
})

describe('occupiesDesk / needsAttention', () => {
  it('工位阶段占用工位，standby/off-floor 不占用', () => {
    expect(occupiesDesk('working')).toBe(true)
    expect(occupiesDesk('needs-approval')).toBe(true)
    expect(occupiesDesk('paused')).toBe(true)
    expect(occupiesDesk('standby')).toBe(false)
    expect(occupiesDesk('off-floor')).toBe(false)
  })

  it('只有等待与故障需要注意力', () => {
    expect(needsAttention('needs-approval')).toBe(true)
    expect(needsAttention('needs-input')).toBe(true)
    expect(needsAttention('failed')).toBe(true)
    expect(needsAttention('working')).toBe(false)
  })
})

describe('allocateSeats', () => {
  it('一个 Agent 一个工位；两个忙碌 Agent 分到不同工位', () => {
    const a = busy(null)
    const b = busy(null)
    const result = allocateSeats([a, { ...b, id: 'a2' }])
    expect(result.desks['a1']).toBe(0)
    expect(result.desks['a2']).toBe(1)
    expect(result.unseated).toEqual([])
  })

  it('重复派发保持原工位（稳定分配）', () => {
    const first = allocateSeats([busy(null), { ...busy(null), id: 'a2' }])
    const again = allocateSeats([{ ...busy(null), id: 'a2' }, busy(null)], first)
    expect(again.desks['a1']).toBe(first.desks['a1'])
    expect(again.desks['a2']).toBe(first.desks['a2'])
  })

  it('standby 上等候位，不占工位', () => {
    const result = allocateSeats([agent({ id: 'a1', presence: 'online' })])
    expect(result.bench['a1']).toBe(0)
    expect(result.desks['a1']).toBeUndefined()
  })

  it('超过 8 个工位需求 → unseated', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...busy(null),
      id: `a${index}`,
    }))
    const result = allocateSeats(many)
    expect(Object.keys(result.desks)).toHaveLength(8)
    expect(result.unseated).toHaveLength(1)
  })

  it('超过 6 个等候位 → unseated', () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      agent({ id: `b${index}`, presence: 'online' }),
    )
    const result = allocateSeats(many)
    expect(Object.keys(result.bench)).toHaveLength(6)
    expect(result.unseated).toHaveLength(1)
  })
})

describe('attentionAgents', () => {
  it('按严重度排序：等待授权 > 等待补充 > 故障', () => {
    const list = [
      agent({ id: 'fail', presence: 'error' }),
      busy('input'),
      { ...busy('permission'), id: 'perm' },
    ]
    const ordered = attentionAgents(list).map((item) => item.id)
    expect(ordered[0]).toBe('perm')
    expect(ordered[1]).toBe('a1')
    expect(ordered[2]).toBe('fail')
  })

  it('没有需要注意的 Agent 时返回空', () => {
    expect(attentionAgents([agent({ presence: 'online' })])).toEqual([])
  })
})
