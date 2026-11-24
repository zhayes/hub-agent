import { describe, expect, it } from 'vitest'
import { classifyFailure, decideEscalation } from '../../src/runtime/recovery/failure'

describe('escalation：失败分类与升级链', () => {
  it('沙箱拒绝、限流、权限、协议失败分类', () => {
    expect(classifyFailure({ message: 'Operation not permitted' })).toBe('sandbox_denied')
    expect(classifyFailure({ message: 'HTTP 429 rate limit' })).toBe('provider_rate_limit')
    expect(classifyFailure({ message: 'EACCES: permission denied' })).toBe('permission')
    expect(classifyFailure({ code: 'ACP_PROTOCOL', phase: 'protocol' })).toBe('protocol')
  })

  it('协议/启动失败：Runtime 重试 2 次后请求用户', () => {
    const base = {
      class: 'protocol' as const,
      hasSideEffects: false,
      sameAgentFailures: 0,
      agentSwitches: 0,
      replans: 0,
    }
    expect(decideEscalation({ ...base, protocolRetries: 0 }).action).toBe('runtime_retry')
    expect(decideEscalation({ ...base, protocolRetries: 1 }).action).toBe('runtime_retry')
    expect(decideEscalation({ ...base, protocolRetries: 2 }).action).toBe('request_human')
  })

  it('执行失败：同 Agent 重试 → 换 Agent → 重规划 → 询问用户', () => {
    const base = {
      class: 'execution' as const,
      hasSideEffects: false,
      protocolRetries: 0,
    }
    expect(
      decideEscalation({ ...base, sameAgentFailures: 0, agentSwitches: 0, replans: 0 }).action,
    ).toBe('same_agent_retry')
    expect(
      decideEscalation({ ...base, sameAgentFailures: 2, agentSwitches: 0, replans: 0 }).action,
    ).toBe('switch_agent')
    expect(
      decideEscalation({ ...base, sameAgentFailures: 2, agentSwitches: 1, replans: 0 }).action,
    ).toBe('replan')
    expect(
      decideEscalation({ ...base, sameAgentFailures: 2, agentSwitches: 1, replans: 2 }).action,
    ).toBe('request_human')
  })

  it('有副作用先交 Brain 核验；sandbox_denied 走审批且不计失败', () => {
    expect(
      decideEscalation({
        class: 'execution',
        hasSideEffects: true,
        sameAgentFailures: 0,
        agentSwitches: 0,
        replans: 0,
        protocolRetries: 0,
      }).action,
    ).toBe('brain_decide')

    const denied = decideEscalation({
      class: 'sandbox_denied',
      hasSideEffects: true,
      sameAgentFailures: 0,
      agentSwitches: 0,
      replans: 0,
      protocolRetries: 0,
    })
    expect(denied.action).toBe('approval')
    expect(denied.countedAsFailure).toBe(false)
  })

  it('unknown：核验通过按成功，部分变更交 Brain，无法判定暂停', () => {
    const base = {
      class: 'unknown' as const,
      hasSideEffects: false,
      sameAgentFailures: 0,
      agentSwitches: 0,
      replans: 0,
      protocolRetries: 0,
    }
    expect(decideEscalation({ ...base, sideEffectVerified: 'complete' }).action).toBe(
      'accept_success',
    )
    expect(decideEscalation({ ...base, sideEffectVerified: 'partial' }).action).toBe('brain_decide')
    expect(decideEscalation({ ...base, sideEffectVerified: 'unknown' }).action).toBe('pause')
  })
})
