export interface BenchRecord {
  id: string
  category: string
  expectedVerdict: 'pass' | 'fail'
  actualVerdict: 'pass' | 'fail' | 'manual_required' | 'not_run'
  ok: boolean
  shouldNotSplit: boolean
  subtasks: number
  decisions: number
  approvals: number
  durationMs: number
  error?: string
}

export interface BenchMetrics {
  total: number
  autonomousCompletionRate: number
  verificationMisjudgmentRate: number
  recoverySuccessRate: number | null
  overDecompositionRate: number
  brainDecisionsPerTask: number
  humanInterventionsPerTask: number
  averageDurationMs: number
}

export function computeMetrics(
  records: readonly BenchRecord[],
  recoverySuccessRate: number | null = null,
): BenchMetrics {
  const total = records.length
  const expectedPass = records.filter((record) => record.expectedVerdict === 'pass')
  const expectedFail = records.filter((record) => record.expectedVerdict === 'fail')
  const shouldNotSplit = records.filter((record) => record.shouldNotSplit)

  const passedExpected = expectedPass.filter((record) => record.actualVerdict === 'pass').length
  const falsePass = expectedFail.filter((record) => record.actualVerdict === 'pass').length
  const overSplit = shouldNotSplit.filter((record) => record.subtasks > 1).length

  return {
    total,
    autonomousCompletionRate: ratio(passedExpected, expectedPass.length),
    verificationMisjudgmentRate: ratio(falsePass, expectedFail.length),
    recoverySuccessRate,
    overDecompositionRate: ratio(overSplit, shouldNotSplit.length),
    brainDecisionsPerTask: ratio(
      records.reduce((sum, record) => sum + record.decisions, 0),
      total,
    ),
    humanInterventionsPerTask: ratio(
      records.reduce((sum, record) => sum + record.approvals, 0),
      total,
    ),
    averageDurationMs: ratio(
      records.reduce((sum, record) => sum + record.durationMs, 0),
      total,
    ),
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}
