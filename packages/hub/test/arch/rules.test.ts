import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 架构规则的自证测试：
 *   1. 真实 src 必须通过（规则不是摆设）；
 *   2. 故意违规的 fixture 必须失败（规则真的会咬）。
 *
 * 第 2 条是 M0 的验收项："故意违反 R1 能让 CI 失败"。
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const binName = process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise'
const depcruiseBin = join(repoRoot, 'node_modules', '.bin', binName)

function runDepcruise(args: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(depcruiseBin, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  }
}

describe('architecture rules', () => {
  it('dependency-cruiser 已安装（否则本测试无意义）', () => {
    expect(existsSync(depcruiseBin)).toBe(true)
  })

  it('真实 src 满足 R1–R6、R8、R9', () => {
    const result = runDepcruise(
      ['packages/hub/src', '--config', '.dependency-cruiser.cjs'],
      repoRoot,
    )

    // 防“空转”：解析器配置错误时 depcruise 会输出 0 modules 并怡然返回 0。
    // 曾经踩过：TypeScript 7 不被 depcruise 支持，规则静默失效。
    expect(result.output).toMatch(/\d+ modules?, \d+ dependencies? cruised/)
    expect(result.output).not.toMatch(/0 modules, 0 dependencies cruised/)
    expect(result.output).not.toMatch(/missing-typescript-transpiler/)

    expect(result.output).not.toMatch(/error R\d/)
    expect(result.status).toBe(0)
  })

  it('R1 违规会被拦截（fixture 必须失败）', () => {
    const fixtureDir = join(repoRoot, 'packages/hub/test/arch/fixtures/violation')
    const result = runDepcruise(['src', '--config', 'depcruise.cjs'], fixtureDir)

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('R1')
  })
})
