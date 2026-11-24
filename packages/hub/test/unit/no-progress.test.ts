import { describe, expect, it } from 'vitest'
import { detectNoProgress } from '../../src/runtime/recovery/no-progress'

const base = {
  nowMs: 1_000_000,
  lastEventAtMs: 1_000_000,
  planHashes: [] as string[],
  diffHashes: [] as string[],
  toolCalls: [] as string[],
  budgetUsed: 0,
  budgetLimit: 100,
}

describe('no-progress：卡住检测', () => {
  it('正常推进不误报', () => {
    expect(detectNoProgress(base).stuck).toBe(false)
  })

  it('事件超时', () => {
    const result = detectNoProgress({ ...base, lastEventAtMs: 1_000_000 - 130_000 })
    expect(result.stuck).toBe(true)
    expect(result.reasons.join()).toContain('有效事件')
  })

  it('连续等价计划', () => {
    const result = detectNoProgress({ ...base, planHashes: ['p1', 'p1'] })
    expect(result.reasons.join()).toContain('计划等价')
  })

  it('diff 震荡', () => {
    const result = detectNoProgress({ ...base, diffHashes: ['a', 'b', 'a'] })
    expect(result.reasons.join()).toContain('震荡')
  })

  it('预算异常与重复工具调用', () => {
    const result = detectNoProgress({
      ...base,
      budgetUsed: 95,
      toolCalls: ['read:x', 'read:x', 'read:x'],
    })
    expect(result.stuck).toBe(true)
    expect(result.reasons.join()).toContain('预算')
    expect(result.reasons.join()).toContain('工具调用')
  })
})
