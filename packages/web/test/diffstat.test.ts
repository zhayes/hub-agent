import { describe, expect, it } from 'vitest'
import { parseDiffStat } from '../src/components/ui/diff-stat'

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
