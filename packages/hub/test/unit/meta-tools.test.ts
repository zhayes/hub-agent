import { describe, expect, it } from 'vitest'
import { createMetaTools } from '../../src/brain/pi/meta-tools'
import { buildBrainInput } from '../../src/brain/snapshot'
import { type BrainInput, DEFAULT_BRAIN_BUDGET } from '../../src/brain/types'
import { asGoalId, asTimestamp } from '../../src/domain/ids'
import { applyEvent, emptyState } from '../../src/domain/machine'

function input(): BrainInput {
  const at = asTimestamp(new Date().toISOString())
  const outcome = applyEvent(emptyState, {
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
  })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return buildBrainInput({
    state: outcome.state,
    goalId: 'g1',
    agents: [{ id: 'a1', name: 'mock', status: 'online' }],
    pending: [],
    budget: DEFAULT_BRAIN_BUDGET,
    stateVersion: 1,
  })
}

async function runTool(
  tools: ReturnType<typeof createMetaTools>['tools'],
  name: string,
  params: unknown,
) {
  const tool = tools.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  const result = await tool.execute('call', params, undefined, undefined, {} as never)
  const first = result.content[0]
  return JSON.parse(first?.type === 'text' ? first.text : '{}')
}

describe('Pi meta tools', () => {
  it('discover_agents / get_agent_detail 只读快照', async () => {
    const { tools } = createMetaTools(input())
    const agents = await runTool(tools, 'discover_agents', {})
    expect(agents.agents[0].id).toBe('a1')
    const detail = await runTool(tools, 'get_agent_detail', { agentId: 'a1' })
    expect(detail.agent.name).toBe('mock')
  })

  it('revise_plan / delegate_task / request_human 记录 intent，不直接执行', async () => {
    const { tools, state } = createMetaTools(input())
    await runTool(tools, 'revise_plan', {
      subtasks: [{ title: 'a', description: 'a', requiredCapabilities: [] }],
      reason: 'r',
    })
    await runTool(tools, 'delegate_task', { subtaskId: 's1', objective: 'do a' })
    await runTool(tools, 'request_human', { question: 'ok?' })
    expect(state.actions.map((action) => action.type)).toEqual([
      'revise_plan',
      'delegate',
      'request_human',
    ])
  })

  it('await_any 不阻塞；没有终态时返回 pending', async () => {
    const { tools } = createMetaTools(input())
    const result = await runTool(tools, 'await_any', {})
    expect(result.timedOut).toBe(false)
    expect(result.pending).toEqual([])
  })
})
