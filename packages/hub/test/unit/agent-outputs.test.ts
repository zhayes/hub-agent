import { describe, expect, it } from 'vitest'
import { asAgentId, asTimestamp } from '../../src/domain/ids'
import { collectAgentOutputs } from '../../src/runtime/chat/agent-outputs'
import { IDS, seed } from './domain-fixtures'

const names = new Map([
  [String(IDS.agent), 'workbuddy'],
  ['a-dsh', 'dsh'],
])

function withExecutions(
  overrides: Record<
    string,
    { agentId: string; status: string; result?: string; startedAt?: string }
  >,
) {
  const base = seed()
  const executions = { ...base.executions }
  for (const [id, value] of Object.entries(overrides)) {
    const existing = executions[id]
    if (existing === undefined) continue
    executions[id] = {
      ...existing,
      agentId: asAgentId(value.agentId),
      status: value.status as typeof existing.status,
      ...(value.startedAt === undefined ? {} : { startedAt: asTimestamp(value.startedAt) }),
      ...(value.result === undefined ? {} : { evidence: { result: value.result } }),
    }
  }
  return { ...base, executions }
}

describe('collectAgentOutputs：多 Agent 输出分段', () => {
  it('每个成功执行一段，带上子任务标题与 Agent 名，按开始时间排序', () => {
    const state = withExecutions({
      [IDS.e2]: {
        agentId: 'a-dsh',
        status: 'succeeded',
        result: 'dsh 的 review',
        startedAt: asTimestamp('2026-11-27T04:38:28.000Z'),
      },
      [IDS.e1]: {
        agentId: String(IDS.agent),
        status: 'succeeded',
        result: 'workbuddy 的 review',
        startedAt: asTimestamp('2026-11-27T04:33:00.000Z'),
      },
    })

    const segments = collectAgentOutputs(state, IDS.goal, names)

    expect(segments.map((segment) => segment.agentName)).toEqual(['workbuddy', 'dsh'])
    expect(segments.map((segment) => segment.text)).toEqual([
      'workbuddy 的 review',
      'dsh 的 review',
    ])
    /* 标题来自子任务，正文不再被拼成一条无归属长文 */
    expect(segments[0]?.title).toBe(state.subtasks[IDS.s1]?.title)
    expect(segments[1]?.title).toBe(state.subtasks[IDS.s2]?.title)
  })

  it('跳过没有产出、未成功、以及别的 goal 的执行', () => {
    const state = withExecutions({
      [IDS.e1]: { agentId: String(IDS.agent), status: 'succeeded', result: '   ' },
      [IDS.e2]: { agentId: String(IDS.agent), status: 'failed', result: '不该出现' },
    })

    expect(collectAgentOutputs(state, IDS.goal, names)).toEqual([])
    expect(collectAgentOutputs(state, 'another-goal', names)).toEqual([])
  })

  it('未知 Agent 退回占位名，不丢内容', () => {
    const state = withExecutions({
      [IDS.e1]: { agentId: 'ghost', status: 'succeeded', result: '有内容' },
    })

    const [segment] = collectAgentOutputs(state, IDS.goal, names)
    expect(segment?.agentName).toBe('agent')
    expect(segment?.text).toBe('有内容')
  })
})
