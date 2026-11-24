export type FailureClass =
  | 'protocol'
  | 'startup'
  | 'execution'
  | 'unknown'
  | 'sandbox_denied'
  | 'provider_rate_limit'
  | 'permission'
  | 'resource_conflict'

export type FailurePhase = 'protocol' | 'startup' | 'execution' | 'unknown'

export interface FailureSignal {
  code?: string
  message?: string
  phase?: FailurePhase
}

export function classifyFailure(signal: FailureSignal): FailureClass {
  const text = `${signal.code ?? ''} ${signal.message ?? ''}`.toLowerCase()
  if (text.includes('sandbox_denied') || text.includes('operation not permitted')) {
    return 'sandbox_denied'
  }
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'provider_rate_limit'
  }
  if (text.includes('permission') || text.includes('eacces') || text.includes('forbidden')) {
    return 'permission'
  }
  if (text.includes('econnreset') || text.includes('timeout') || text.includes('etimedout')) {
    return signal.phase ?? 'unknown'
  }
  if (text.includes('protocol') || text.includes('initialize') || text.includes('jsonrpc')) {
    return 'protocol'
  }
  if (text.includes('startup') || text.includes('spawn') || text.includes('enoent')) {
    return 'startup'
  }
  const phase = signal.phase ?? 'execution'
  return phase === 'unknown' ? 'unknown' : phase === 'execution' ? 'execution' : phase
}

export interface EscalationInput {
  class: FailureClass
  /** 执行阶段是否已有 diff/副作用 */
  hasSideEffects: boolean
  /** unknown 时是否已核验；核验通过则按成功收尾 */
  sideEffectVerified?: 'none' | 'partial' | 'complete' | 'unknown'
  sameAgentFailures: number
  agentSwitches: number
  replans: number
  protocolRetries: number
}

export type EscalationAction =
  | 'runtime_retry'
  | 'same_agent_retry'
  | 'brain_decide'
  | 'switch_agent'
  | 'replan'
  | 'request_human'
  | 'pause'
  | 'approval'
  | 'accept_success'
  | 'fail'

export interface EscalationDecision {
  action: EscalationAction
  reason: string
  /** 是否计入 Agent 可靠性统计 */
  countedAsFailure: boolean
  delayMs?: number
}

/**
 * 失败升级链（PRD §15.2）。
 * 阈值：协议重试 2；同 Agent 失败 2 次换 Agent；换 Agent 后重规划 2 次；再问用户。
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (input.class === 'sandbox_denied') {
    return { action: 'approval', reason: '沙箱拦截走审批，不静默重试', countedAsFailure: false }
  }
  if (input.class === 'provider_rate_limit') {
    if (input.protocolRetries < 2) {
      return {
        action: 'runtime_retry',
        reason: 'Provider 限流：退避重试',
        countedAsFailure: false,
        delayMs: 2 ** (input.protocolRetries + 1) * 500,
      }
    }
    return { action: 'request_human', reason: 'Provider 限流重试耗尽', countedAsFailure: false }
  }
  if (input.class === 'protocol' || input.class === 'startup') {
    if (input.protocolRetries < 2) {
      return {
        action: 'runtime_retry',
        reason: `协议/启动失败：Runtime 重试第 ${input.protocolRetries + 1} 次`,
        countedAsFailure: false,
        delayMs: 2 ** input.protocolRetries * 500,
      }
    }
    return { action: 'request_human', reason: '协议/启动重试耗尽', countedAsFailure: false }
  }

  if (input.class === 'unknown') {
    if (input.sideEffectVerified === 'complete') {
      return {
        action: 'accept_success',
        reason: 'unknown 核验通过，按成功收尾',
        countedAsFailure: false,
      }
    }
    if (input.sideEffectVerified === 'partial') {
      return {
        action: 'brain_decide',
        reason: 'unknown 有部分变更，交 Brain 决定',
        countedAsFailure: true,
      }
    }
    return { action: 'pause', reason: 'unknown 无法判定，暂停并保留现场', countedAsFailure: false }
  }

  // execution / permission / resource_conflict
  if (input.hasSideEffects) {
    return {
      action: 'brain_decide',
      reason: '失败前已有副作用，先核验再决定继续/回滚/换 Agent',
      countedAsFailure: true,
    }
  }
  if (input.sameAgentFailures < 2) {
    return {
      action: 'same_agent_retry',
      reason: `无副作用失败：同 Agent 重试（已失败 ${input.sameAgentFailures} 次）`,
      countedAsFailure: true,
    }
  }
  if (input.agentSwitches < 1) {
    return {
      action: 'switch_agent',
      reason: '同一 Subtask 连续失败 2 次，换 Agent',
      countedAsFailure: true,
    }
  }
  if (input.replans < 2) {
    return {
      action: 'replan',
      reason: '换 Agent 后仍失败，重新规划',
      countedAsFailure: true,
    }
  }
  return {
    action: 'request_human',
    reason: '换 Agent + 重规划阈值耗尽，请求用户决策',
    countedAsFailure: true,
  }
}
