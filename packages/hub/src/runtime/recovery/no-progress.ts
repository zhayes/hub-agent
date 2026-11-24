export interface NoProgressThresholds {
  /** 距上一次有效事件的阈值 */
  staleEventMs: number
  /** 预算消耗比例阈值 */
  budgetRatio: number
  /** 同一工具调用重复次数 */
  repeatedToolCount: number
}

export const DEFAULT_NO_PROGRESS_THRESHOLDS: NoProgressThresholds = {
  staleEventMs: 120_000,
  budgetRatio: 0.9,
  repeatedToolCount: 3,
}

export interface NoProgressInput {
  nowMs: number
  lastEventAtMs: number
  planHashes: readonly string[]
  diffHashes: readonly string[]
  toolCalls: readonly string[]
  budgetUsed: number
  budgetLimit: number
  thresholds?: Partial<NoProgressThresholds>
}

export interface NoProgressResult {
  stuck: boolean
  reasons: string[]
}

/**
 * 无进展检测（PRD §15.3）：事件超时、等价计划、diff 震荡、预算异常、重复工具调用。
 * 命中任一即应产生决策点；这里只做确定性判断，不直接暂停。
 */
export function detectNoProgress(input: NoProgressInput): NoProgressResult {
  const thresholds = { ...DEFAULT_NO_PROGRESS_THRESHOLDS, ...input.thresholds }
  const reasons: string[] = []

  if (input.nowMs - input.lastEventAtMs > thresholds.staleEventMs) {
    reasons.push(`距上次有效事件超过 ${thresholds.staleEventMs}ms`)
  }

  const plans = input.planHashes.slice(-2)
  if (plans.length === 2 && plans[0] === plans[1]) {
    reasons.push('连续两次计划等价')
  }

  const diffs = input.diffHashes.slice(-3)
  if (diffs.length === 3 && diffs[0] === diffs[2] && diffs[0] !== diffs[1]) {
    reasons.push('diff 反复震荡')
  }

  if (input.budgetLimit > 0 && input.budgetUsed / input.budgetLimit >= thresholds.budgetRatio) {
    reasons.push(`预算消耗达到 ${Math.round((input.budgetUsed / input.budgetLimit) * 100)}%`)
  }

  const calls = input.toolCalls.slice(-thresholds.repeatedToolCount)
  if (calls.length === thresholds.repeatedToolCount && calls.every((call) => call === calls[0])) {
    reasons.push('同一工具调用重复')
  }

  return { stuck: reasons.length > 0, reasons }
}
