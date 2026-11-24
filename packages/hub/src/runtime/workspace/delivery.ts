import { writeFileSync } from 'node:fs'
import { HubError } from '../../shared/errors'
import { diffPatch, type GitRunner, mergeNoFf, revParse } from './git'

export type DeliveryMode = 'branch-only' | 'patch-export' | 'auto-merge'

export interface DeliveryPreconditions {
  verificationPass: boolean
  diffScopeClean: boolean
  pendingApprovals: number
  targetAdvanced: boolean
  projectAutoMerge: boolean
  targetRef?: string
}

export interface DeliveryDecision {
  requested: DeliveryMode
  effective: DeliveryMode
  downgraded: boolean
  reasons: string[]
}

/**
 * auto-merge 的五个前置条件缺一即降级为 branch-only（PRD §6.12.4）。
 * Brain 不能指定交付模式；这里只执行用户/项目策略。
 */
export function decideDelivery(
  requested: DeliveryMode,
  pre: DeliveryPreconditions,
): DeliveryDecision {
  if (requested !== 'auto-merge') {
    return { requested, effective: requested, downgraded: false, reasons: [] }
  }
  const reasons: string[] = []
  if (!pre.verificationPass) reasons.push('verification 未通过')
  if (!pre.diffScopeClean) reasons.push('diffScope 有违规')
  if (pre.pendingApprovals > 0) reasons.push(`仍有 ${pre.pendingApprovals} 个 pending Approval`)
  if (pre.targetRef === undefined) reasons.push('未配置 targetRef')
  if (pre.targetAdvanced) reasons.push('目标分支已前进')
  if (!pre.projectAutoMerge) reasons.push('项目未显式开启 autoMerge')

  return reasons.length === 0
    ? { requested, effective: 'auto-merge', downgraded: false, reasons: [] }
    : { requested, effective: 'branch-only', downgraded: true, reasons }
}

export interface DeliveryInput {
  mode: DeliveryMode
  runner: GitRunner
  repoRoot: string
  branch: string
  baseRef: string
  targetRef?: string
  patchPath?: string
}

export interface DeliveryResult {
  mode: DeliveryMode
  branch: string
  commitSha?: string
  targetingRef?: string
  patchRef?: string
  downgraded?: { requested: DeliveryMode; reasons: string[] }
}

export async function executeDelivery(input: DeliveryInput): Promise<DeliveryResult> {
  const commitSha = await revParse(input.runner, input.repoRoot, input.branch)
  if (input.mode === 'branch-only') {
    return {
      mode: 'branch-only',
      branch: input.branch,
      ...(commitSha === undefined ? {} : { commitSha }),
    }
  }

  if (input.mode === 'patch-export') {
    if (input.patchPath === undefined) {
      throw new HubError('DELIVERY_CONFLICT', 'patch-export 需要 patchPath')
    }
    const patch = await diffPatch(input.runner, input.repoRoot, input.baseRef, input.branch)
    writeFileSync(input.patchPath, patch, 'utf8')
    return {
      mode: 'patch-export',
      branch: input.branch,
      ...(commitSha === undefined ? {} : { commitSha }),
      patchRef: input.patchPath,
    }
  }

  if (input.targetRef === undefined) {
    throw new HubError('DELIVERY_CONFLICT', 'auto-merge 需要 targetRef')
  }
  await mergeNoFf(input.runner, input.repoRoot, input.branch)
  const merged = await revParse(input.runner, input.repoRoot, 'HEAD')
  return {
    mode: 'auto-merge',
    branch: input.branch,
    targetingRef: input.targetRef,
    ...(merged === undefined ? {} : { commitSha: merged }),
  }
}
