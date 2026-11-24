import { describe, expect, it } from 'vitest'
import { classifySideEffect } from '../../src/runtime/recovery/side-effect'

describe('side-effect：失败前是否有副作用', () => {
  it('无 changedFiles → unknown，有空数组 → none', () => {
    expect(classifySideEffect({})).toBe('unknown')
    expect(classifySideEffect({ changedFiles: [] })).toBe('none')
  })

  it('有 diff + 验收通过 → complete；验收失败 → partial', () => {
    expect(classifySideEffect({ changedFiles: ['a.ts'], verificationVerdict: 'pass' })).toBe(
      'complete',
    )
    expect(classifySideEffect({ changedFiles: ['a.ts'], verificationVerdict: 'fail' })).toBe(
      'partial',
    )
  })
})
