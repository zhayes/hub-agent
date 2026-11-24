import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createBrainFromEnv } from '../../src/brain/create-brain'
import { LlmBrain } from '../../src/brain/pi/llm-brain'
import type { LlmClient, LlmCompletionRequest } from '../../src/brain/pi/llm-client'
import { OpenAiCompatibleClient } from '../../src/brain/pi/llm-client'
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

describe('LlmBrain：真实模型适配器', () => {
  it('解析 actions 并复用缓存 explain，不再二次调用模型', async () => {
    let calls = 0
    let seen: LlmCompletionRequest | undefined
    const client: LlmClient = {
      async complete(request) {
        calls += 1
        seen = request
        return JSON.stringify({
          actions: [
            {
              type: 'revise_plan',
              subtasks: [{ title: '修 bug', description: '修 bug', requiredCapabilities: [] }],
              reason: '单子任务',
            },
          ],
        })
      },
    }
    const brain = new LlmBrain({ client })
    const snapshot = input()
    const actions = await brain.step(snapshot)
    expect(actions[0]?.type).toBe('revise_plan')
    expect(calls).toBe(1)
    expect(seen?.system).toContain('Brain')
    expect(seen?.user).toContain('修 bug')

    const rationales = await brain.explain(snapshot)
    expect(calls).toBe(1)
    expect(rationales[0]?.type).toBe('decompose')
    expect(rationales[0]?.rationale).toBe('单子任务')
  })

  it('非法 JSON 归因 BRAIN_UNAVAILABLE，不静默通过', async () => {
    const brain = new LlmBrain({
      client: { complete: async () => 'not json' },
    })
    await expect(brain.step(input())).rejects.toMatchObject({ code: 'BRAIN_UNAVAILABLE' })
  })

  it('缺少 actions 数组也拒绝', async () => {
    const brain = new LlmBrain({
      client: { complete: async () => JSON.stringify({ nope: true }) },
    })
    await expect(brain.step(input())).rejects.toMatchObject({ code: 'BRAIN_UNAVAILABLE' })
  })
})

describe('createBrainFromEnv', () => {
  it('默认真实 LLM；无 key fail-closed；显式 scripted 才降级', () => {
    expect(() => createBrainFromEnv({})).toThrowError(/HUBAGENT_BRAIN_API_KEY/)
    expect(() => createBrainFromEnv({ HUBAGENT_BRAIN_MODE: 'llm' })).toThrowError(/API_KEY/)
    expect(createBrainFromEnv({ HUBAGENT_BRAIN_MODE: 'scripted' }).constructor.name).toBe(
      'ScriptedBrain',
    )
  })

  it('llm 配置完整时返回 LlmBrain', () => {
    const brain = createBrainFromEnv({
      HUBAGENT_BRAIN_MODE: 'llm',
      HUBAGENT_BRAIN_API_KEY: 'test-key',
      HUBAGENT_BRAIN_BASE_URL: 'https://example.invalid/v1',
      HUBAGENT_BRAIN_MODEL: 'test-model',
    })
    expect(brain.constructor.name).toBe('LlmBrain')
  })
})

describe('OpenAiCompatibleClient', () => {
  it('解析 choices[].message.content 并携带 Bearer key', async () => {
    let authorization = ''
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? ''
      request.resume()
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"actions":[]}' } }],
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      const client = new OpenAiCompatibleClient({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'test-model',
      })
      const content = await client.complete({
        system: 's',
        user: 'u',
        maxTokens: 100,
        timeoutMs: 5_000,
      })
      expect(content).toBe('{"actions":[]}')
      expect(authorization).toBe('Bearer test-key')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('HTTP 错误归因 BRAIN_UNAVAILABLE', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 500
      response.end('boom')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      const client = new OpenAiCompatibleClient({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'test-model',
      })
      await expect(
        client.complete({ system: 's', user: 'u', maxTokens: 100, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: 'BRAIN_UNAVAILABLE' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
