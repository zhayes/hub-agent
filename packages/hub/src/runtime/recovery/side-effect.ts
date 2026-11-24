export type SideEffectClass = 'none' | 'partial' | 'complete' | 'unknown'

export interface SideEffectInput {
  changedFiles?: readonly string[]
  verificationVerdict?: 'pass' | 'fail' | 'manual_required'
}

/**
 * 失败/unknown 的副作用核验（PRD §15.2）。
 * 没有 diff 不代表一定安全（可能改了未跟踪文件），调用方应优先传 changedFiles。
 */
export function classifySideEffect(input: SideEffectInput): SideEffectClass {
  if (input.changedFiles === undefined) return 'unknown'
  if (input.changedFiles.length === 0) return 'none'
  if (input.verificationVerdict === 'pass') return 'complete'
  return 'partial'
}
