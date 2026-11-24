import { describe, expect, it } from 'vitest'
import { type BenchRecord, computeMetrics } from '../../src/bench/metrics'

const record = (overrides: Partial<BenchRecord>): BenchRecord => ({
  id: 'r',
  category: 'test',
  expectedVerdict: 'pass',
  actualVerdict: 'pass',
  ok: true,
  shouldNotSplit: false,
  subtasks: 1,
  decisions: 2,
  approvals: 0,
  durationMs: 100,
  ...overrides,
})

describe('bench metrics', () => {
  it('计算完成率、误判率、过度拆解率', () => {
    const metrics = computeMetrics([
      record({}),
      record({ id: 'b', actualVerdict: 'fail', ok: false }),
      record({ id: 'c', expectedVerdict: 'fail', actualVerdict: 'fail', ok: false }),
      record({ id: 'd', expectedVerdict: 'fail', actualVerdict: 'pass' }),
      record({ id: 'e', shouldNotSplit: true, subtasks: 2 }),
    ])
    expect(metrics.total).toBe(5)
    expect(metrics.autonomousCompletionRate).toBeCloseTo(2 / 3)
    expect(metrics.verificationMisjudgmentRate).toBe(0.5)
    expect(metrics.overDecompositionRate).toBe(1)
    expect(metrics.brainDecisionsPerTask).toBe(2)
    expect(metrics.recoverySuccessRate).toBeNull()
  })
})
