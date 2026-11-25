import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 边界测试（PLAN-AGENT-OFFICE §4.1 / §7.1）：
 * 1. 只有 scene/** 可以 import three；
 * 2. scene/** 不得 import shared/api、components/ui、routes（场景只「指」不「决」）。
 */

const WEB_SRC = join(process.cwd(), 'packages/web/src')
const SCENE_DIR = join(WEB_SRC, 'features/agents/office/scene')

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path)
  }
  return files
}

const files = walk(WEB_SRC)

describe('three 边界', () => {
  it('只有 scene/** 可以 import three', () => {
    const offenders = files.filter((file) => {
      if (file.startsWith(SCENE_DIR)) return false
      return /from\s+['"]three['"]/.test(readFileSync(file, 'utf8'))
    })
    expect(offenders.map((file) => relative(WEB_SRC, file))).toEqual([])
  })

  it('scene/** 不得 import shared/api、components/ui、routes', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (!file.startsWith(SCENE_DIR)) continue
      const source = readFileSync(file, 'utf8')
      if (
        /from\s+['"][^'"]*shared\/api['"]/.test(source) ||
        /from\s+['"][^'"]*components\/ui['"]/.test(source) ||
        /from\s+['"][^'"]*routes['"]/.test(source)
      ) {
        offenders.push(relative(WEB_SRC, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
