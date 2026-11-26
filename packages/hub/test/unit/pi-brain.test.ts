import { describe, expect, it } from 'vitest'
import { createBrainFromEnv } from '../../src/brain/create-brain'
import { PiBrain } from '../../src/brain/pi/pi-brain'
import type { CreatePiSessionInput, PiSession, PiSessionFactory } from '../../src/brain/pi/session'
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
      title: '修 bug',
      intent: '修 bug',
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

class FakeFactory implements PiSessionFactory {
  inputs: CreatePiSessionInput[] = []
  prompts: string[] = []
  disposed = 0
  text =
    '{"actions":[{"type":"revise_plan","subtasks":[{"title":"修 bug","description":"修 bug","requiredCapabilities":[]}],"reason":"单子任务"}]}'

  async create(input: CreatePiSessionInput): Promise<PiSession> {
    this.inputs.push(input)
    return {
      prompt: async (value) => {
        this.prompts.push(value)
      },
      getLastAssistantText: () => this.text,
      dispose: () => {
        this.disposed += 1
      },
    }
  }
}

describe('PiBrain：官方 Pi SDK 适配器', () => {
  it('用 Pi session 产出 actions，复用缓存 explain，并始终 dispose', async () => {
    const factory = new FakeFactory()
    const brain = new PiBrain({ factory, cwd: '/tmp/work' })
    const snapshot = input()
    const actions = await brain.step(snapshot)
    expect(actions[0]?.type).toBe('revise_plan')
    expect(factory.inputs[0]?.cwd).toBe('/tmp/work')
    expect(factory.inputs[0]?.systemPrompt).toContain('HubAgent')
    expect(factory.prompts[0]).toContain('修 bug')
    expect(factory.disposed).toBe(1)

    const rationales = await brain.explain(snapshot)
    expect(factory.disposed).toBe(1)
    expect(rationales[0]?.type).toBe('decompose')
    expect(rationales[0]?.rationale).toBe('单子任务')
  })

  it('非 JSON 文本按 reply 处理，不把对话判成失败', async () => {
    const factory = new FakeFactory()
    factory.text = '你好，我是 HubAgent。'
    const brain = new PiBrain({ factory })
    const actions = await brain.step(input())
    expect(actions).toEqual([{ type: 'reply', text: '你好，我是 HubAgent。' }])
    expect(factory.disposed).toBe(1)
  })

  it('空 assistant 文本返回空动作', async () => {
    const factory = new FakeFactory()
    factory.text = ''
    const brain = new PiBrain({ factory })
    await expect(brain.step(input())).resolves.toEqual([])
  })
})

describe('createBrainFromEnv', () => {
  it('默认 PiBrain；显式 scripted 才降级', () => {
    expect(createBrainFromEnv({}).constructor.name).toBe('PiBrain')
    expect(createBrainFromEnv({ HUBAGENT_BRAIN_MODE: 'scripted' }).constructor.name).toBe(
      'ScriptedBrain',
    )
    expect(() => createBrainFromEnv({ HUBAGENT_BRAIN_MODE: 'llm' })).toThrowError(/pi/)
  })
})

class ToolCallingFactory implements PiSessionFactory {
  disposed = 0
  seenTools: string[] = []

  async create(input: CreatePiSessionInput): Promise<PiSession> {
    this.seenTools = (input.tools ?? []).map((tool) => tool.name)
    return {
      prompt: async () => {
        const revise = input.tools?.find((tool) => tool.name === 'revise_plan')
        if (revise === undefined) throw new Error('revise_plan tool missing')
        await revise.execute(
          'call-1',
          {
            subtasks: [{ title: 'tool plan', description: 'tool plan', requiredCapabilities: [] }],
            reason: 'planned via meta tool',
          },
          undefined,
          undefined,
          {} as never,
        )
      },
      getLastAssistantText: () => 'done',
      dispose: () => {
        this.disposed += 1
      },
    }
  }
}

describe('Pi 元工具循环', () => {
  it('工具记录的 intent 优先于最终自然语言，session 仍 dispose', async () => {
    const factory = new ToolCallingFactory()
    const brain = new PiBrain({ factory })
    const actions = await brain.step(input())
    expect(factory.seenTools).toContain('reply')
    expect(factory.seenTools).toContain('discover_agents')
    expect(factory.seenTools).toContain('revise_plan')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('revise_plan')
    if (actions[0]?.type === 'revise_plan') {
      expect(actions[0].reason).toBe('planned via meta tool')
    }
    expect(factory.disposed).toBe(1)
  })
})
