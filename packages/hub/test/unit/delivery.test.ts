import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type DeliveryPreconditions,
  decideDelivery,
  executeDelivery,
} from '../../src/runtime/workspace/delivery'
import type { GitResult, GitRunner } from '../../src/runtime/workspace/git'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const allPass: DeliveryPreconditions = {
  verificationPass: true,
  diffScopeClean: true,
  pendingApprovals: 0,
  targetAdvanced: false,
  projectAutoMerge: true,
  targetRef: 'main',
}

class FakeRunner implements GitRunner {
  async run(args: readonly string[]): Promise<GitResult> {
    if (args.includes('diff')) return { ok: true, code: 0, stdout: 'diff --git a b\n', stderr: '' }
    return { ok: true, code: 0, stdout: 'sha-123\n', stderr: '' }
  }
}

describe('delivery：默认 branch-only，auto-merge 缺条件降级', () => {
  it('branch-only 不需要任何合并前置条件', () => {
    const decision = decideDelivery('branch-only', {
      ...allPass,
      verificationPass: false,
      projectAutoMerge: false,
      targetRef: undefined,
    })
    expect(decision.effective).toBe('branch-only')
    expect(decision.downgraded).toBe(false)
  })

  it('auto-merge 五条件全满足才生效', () => {
    const decision = decideDelivery('auto-merge', allPass)
    expect(decision.effective).toBe('auto-merge')
    expect(decision.downgraded).toBe(false)
  })

  it('缺任一条件即降级 branch-only 并记录原因', () => {
    for (const override of [
      { verificationPass: false },
      { diffScopeClean: false },
      { pendingApprovals: 1 },
      { targetAdvanced: true },
      { projectAutoMerge: false },
      { targetRef: undefined },
    ]) {
      const decision = decideDelivery('auto-merge', { ...allPass, ...override })
      expect(decision.effective).toBe('branch-only')
      expect(decision.downgraded).toBe(true)
      expect(decision.reasons.length).toBeGreaterThan(0)
    }
  })

  it('branch-only / patch-export 执行结果可核对', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubagent-delivery-'))
    dirs.push(dir)
    const runner = new FakeRunner()

    const branchOnly = await executeDelivery({
      mode: 'branch-only',
      runner,
      repoRoot: dir,
      branch: 'feat/a',
      baseRef: 'base',
    })
    expect(branchOnly.mode).toBe('branch-only')
    expect(branchOnly.commitSha).toBe('sha-123')

    const patchPath = join(dir, 'change.patch')
    const patch = await executeDelivery({
      mode: 'patch-export',
      runner,
      repoRoot: dir,
      branch: 'feat/a',
      baseRef: 'base',
      patchPath,
    })
    expect(patch.mode).toBe('patch-export')
    expect(patch.patchRef).toBe(patchPath)
    expect(existsSync(patchPath)).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).toContain('diff --git')

    const merged = await executeDelivery({
      mode: 'auto-merge',
      runner,
      repoRoot: dir,
      branch: 'feat/a',
      baseRef: 'base',
      targetRef: 'main',
    })
    expect(merged.mode).toBe('auto-merge')
    expect(merged.targetingRef).toBe('main')
  })
})
