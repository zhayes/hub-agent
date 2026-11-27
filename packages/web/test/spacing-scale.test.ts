import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 间距守卫（UI-SPEC §9「间距落在同一套刻度上」）。
 *
 * 清单原本写「4/8/12/16/24/32/48」，但已批准的视觉稿用的是 18（聊天头部上内距）、
 * 14（下内距）、22（回合间距）、9（用户气泡与输入壳），它们不在 4px 网格上。
 * 与其为了对齐清单去改掉已评审过的稿子，不如把**当前这套**固化下来：
 * 任何**新增**的任意值都会在这里变红，于是「量度漂移」被挡住，而不是靠人记。
 *
 * 数值的来源：
 * - 2 / 3 / 5 / 7 —— 控件内光学校正（图标槽、徽标间距、竖排文字的基线微调）
 * - 9 / 14 / 18 / 22 —— 见上，全部来自 v9 / v2 稿
 * - 26 —— 过程流的标识位缩进（18px 槽 + 8）
 */
const ALLOWED = new Set([2, 3, 5, 7, 9, 14, 18, 22, 26])

const WEB_SRC = join(process.cwd(), 'packages/web/src')

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (path.endsWith('.tsx') || path.endsWith('.ts')) files.push(path)
  }
  return files
}

/* 只查间距类工具（内边距/外边距/间隙）；尺寸（w-/h-/size-）是结构，不在本条范围。 */
const SPACING = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[(\d+(?:\.\d+)?)px\]/g

describe('间距刻度', () => {
  it('没有白名单之外的任意间距值', () => {
    const offenders: string[] = []
    for (const file of walk(WEB_SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(SPACING)) {
        const value = Number.parseFloat(match[1] ?? '0')
        if (ALLOWED.has(value)) continue
        offenders.push(`${relative(WEB_SRC, file)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
