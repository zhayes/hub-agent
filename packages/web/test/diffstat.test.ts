import { describe, expect, it } from 'vitest'
import { parseDiffStat, parseUnifiedDiff } from '../src/components/ui/diff-stat'

describe('parseDiffStat', () => {
  it('reads per-file counts and the summary line', () => {
    const stat = [
      ' src/auth/session.ts | 14 +++++++++-----',
      ' src/auth/cookie.ts  |  8 ++++----',
      ' 2 files changed, 14 insertions(+), 8 deletions(-)',
    ].join('\n')

    const parsed = parseDiffStat(stat)
    expect(parsed.files).toEqual([
      { path: 'src/auth/session.ts', added: 9, removed: 5 },
      { path: 'src/auth/cookie.ts', added: 4, removed: 4 },
    ])
    expect(parsed.summary).toBe('2 files changed, 14 insertions(+), 8 deletions(-)')
  })

  it('ignores binary markers and blank lines', () => {
    const stat = ['', ' assets/logo.png | Bin 0 -> 1024 bytes', ' 1 file changed, 0 insertions(+)']
      .join('\n')
      .trim()

    const parsed = parseDiffStat(stat)
    expect(parsed.files).toEqual([])
    expect(parsed.summary).toBe('1 file changed, 0 insertions(+)')
  })

  it('survives output that is not a diffstat at all', () => {
    expect(parseDiffStat('fatal: not a git repository').files).toEqual([])
  })
})

describe('parseUnifiedDiff', () => {
  it('splits files and keeps hunk lines verbatim', () => {
    const patch = [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' }',
    ].join('\n')

    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('src/auth/session.ts')
    expect(files[0]?.hunks[0]?.header).toBe('@@ -1,3 +1,4 @@')
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const b = 3' },
      { kind: 'add', text: 'const c = 4' },
      { kind: 'context', text: '}' },
    ])
  })

  it('flags binary and new files without inventing hunks', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/logo.png differ',
    ].join('\n')

    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(1)
    expect(files[0]?.note).toBe('binary')
    expect(files[0]?.hunks).toEqual([])
  })

  it('keeps deleted lines that start with a double dash inside a hunk', () => {
    const patch = [
      'diff --git a/x.sql b/x.sql',
      '@@ -1,1 +1,1 @@',
      '--- a comment line',
      '+-- another comment',
    ].join('\n')

    const files = parseUnifiedDiff(patch)
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: '-- a comment line' },
      { kind: 'add', text: '-- another comment' },
    ])
  })
})
