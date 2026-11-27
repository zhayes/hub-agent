#!/usr/bin/env node
/**
 * 令牌对比度检查（UI-SPEC §9 第一条「文案对比度 ≥4.5:1；控件边界 ≥3:1，脚本可测」）。
 *
 * 读 `packages/web/src/styles/tokens.css` 里的 light-dark(a, b)，对每对前景/背景
 * 分别按亮/暗两套算 WCAG 2.1 对比度。只检查**真实会同时出现**的组合：
 * 把不存在的组合也塞进来，会逼着人去调根本用不到的颜色。
 *
 *   pnpm contrast          → 只报错
 *   pnpm contrast --verbose → 连通过的组合一起打印
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tokensPath = join(process.cwd(), 'packages/web/src/styles/tokens.css')

/** 正文/元信息用：≥4.5（WCAG AA 小字）。 */
const TEXT_MIN = 4.5
/** 控件边框/焦点环：≥3（WCAG AA 非文本）。 */
const UI_MIN = 3

function hexToRgb(hex) {
  const value = hex.trim().replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function channel(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a, b) {
  const la = luminance(hexToRgb(a))
  const lb = luminance(hexToRgb(b))
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

const css = readFileSync(tokensPath, 'utf8')

/** `--hx-name: light-dark(#fff, #000);` → { name: [light, dark] } */
const tokens = new Map()
for (const match of css.matchAll(/--hx-([\w-]+):\s*light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/g)) {
  const [, name, light, dark] = match
  tokens.set(name, [light.trim(), dark.trim()])
}

/** 只有单值的令牌（阴影、缓动）：跳过。 */
const missing = (name) => {
  if (!tokens.has(name)) {
    console.error(`✗ 令牌缺失：--hx-${name}`)
    process.exit(2)
  }
  return tokens.get(name)
}

const TEXT_PAIRS = [
  ['fg-default', 'bg-canvas'],
  ['fg-default', 'bg-surface'],
  ['fg-default', 'bg-raised'],
  ['fg-default', 'bg-subtle'],
  ['fg-muted', 'bg-canvas'],
  ['fg-muted', 'bg-surface'],
  ['fg-muted', 'bg-raised'],
  ['fg-muted', 'bg-subtle'],
  ['fg-subtle', 'bg-canvas'],
  ['fg-subtle', 'bg-surface'],
  ['fg-subtle', 'bg-raised'],
  ['fg-subtle', 'bg-subtle'],
  ['accent', 'bg-canvas'],
  ['accent', 'bg-surface'],
  ['accent', 'accent-soft'],
  ['success', 'bg-canvas'],
  ['success', 'bg-surface'],
  ['success', 'success-soft'],
  ['warning', 'bg-surface'],
  ['warning', 'warning-soft'],
  ['danger', 'bg-canvas'],
  ['danger', 'bg-surface'],
  ['danger', 'danger-soft'],
]

const UI_PAIRS = [
  ['line-control', 'bg-canvas'],
  ['line-control', 'bg-surface'],
  ['ring', 'bg-canvas'],
  ['ring', 'bg-surface'],
]

const verbose = process.argv.includes('--verbose')
const failures = []

function check(pairs, min, label) {
  for (const [fgName, bgName] of pairs) {
    const fg = missing(fgName)
    const bg = missing(bgName)
    for (const [index, theme] of ['light', 'dark'].entries()) {
      const ratio = contrast(fg[index], bg[index])
      const ok = ratio >= min
      if (!ok || verbose) {
        const line = `${ok ? '✓' : '✗'} [${theme}] ${fgName} on ${bgName}: ${ratio.toFixed(2)} (min ${min})`
        if (ok) console.log(line)
        else {
          console.error(line)
          failures.push({ label, theme, fgName, bgName, ratio, min })
        }
      }
    }
  }
}

check(TEXT_PAIRS, TEXT_MIN, 'text')
check(UI_PAIRS, UI_MIN, 'ui')

if (failures.length > 0) {
  console.error(`\n${failures.length} 处对比度不达标（UI-SPEC §9）`)
  process.exit(1)
}

console.log(`✓ 对比度全部达标：${TEXT_PAIRS.length * 2} 组文字（≥${TEXT_MIN}）、${UI_PAIRS.length * 2} 组边界（≥${UI_MIN}）`)
