import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * R7：禁止 barrel 文件（ARCHITECTURE §3.1）。
 * 依赖规则无法表达"这个文件只是转发"，所以直接断言文件不存在。
 */
const srcDir = fileURLToPath(new URL('../../src/', import.meta.url))

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collect(full)))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }

  return files
}

describe('R7 · no barrel files', () => {
  it('src 下不存在 index.ts / index.js 之类的转发文件', async () => {
    const files = await collect(srcDir)
    const barrels = files
      .filter((file) => /\bindex\.(ts|tsx|js|mjs|cjs)$/.test(file))
      .map((file) => relative(srcDir, file))

    expect(barrels).toEqual([])
  })

  it('src 目录本身存在（防止路径写错导致空断言）', async () => {
    const info = await stat(srcDir)
    expect(info.isDirectory()).toBe(true)
  })
})
