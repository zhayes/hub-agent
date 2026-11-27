import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI 层白名单（AGENTS.md「不得在 features/**、routes/** 直接 import @ui-sdk/* 或 @lucide/solid」）。
 *
 * SDK 还在 beta：把它的 import 收在 `components/ui/*` 门面里，换版本时只改一处。
 * 唯一合法的例外是 `src/dev/DevUiView.tsx`（组件画廊，`import.meta.env.DEV` 才进图）。
 * 它刻意不在 `features/` 下——画廊的用途就是展示 SDK 裸行为，不该待在业务目录里。
 */

const WEB_SRC = join(process.cwd(), 'packages/web/src')

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
const GALLERY = join(WEB_SRC, 'dev/DevUiView.tsx')

const importsSdk = (source: string): boolean =>
  /from\s+['"]@ui-sdk\/[^'"]+['"]/.test(source) || /from\s+['"]@lucide\/solid[^'"]*['"]/.test(source)

describe('UI 依赖白名单', () => {
  it('只有 components/ui/** 与画廊可以 import @ui-sdk / @lucide/solid', () => {
    const offenders = files
      .filter((file) => file !== GALLERY)
      .filter((file) => !file.startsWith(join(WEB_SRC, 'components/ui')))
      .filter((file) => importsSdk(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(WEB_SRC, file))).toEqual([])
  })

  it('features/** 与 routes/** 一律走门面', () => {
    const offenders = files
      .filter(
        (file) =>
          file.startsWith(join(WEB_SRC, 'features')) || file.startsWith(join(WEB_SRC, 'routes')),
      )
      .filter((file) => importsSdk(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(WEB_SRC, file))).toEqual([])
  })

  it('画廊留在 features/ 之外（否则上面两条就成了空话）', () => {
    const strays = files.filter(
      (file) => file.startsWith(join(WEB_SRC, 'features')) && file.includes('DevUiView'),
    )
    expect(strays.map((file) => relative(WEB_SRC, file))).toEqual([])
  })
})
