import { describe, expect, it } from 'vitest'
import { formatDuration, shortenId } from '../src/shared/format'

describe('shortenId', () => {
  it('keeps the type prefix and the distinguishing tail of a ULID', () => {
    expect(shortenId('task_01HQ8X2K4M9RTA3V6P0WYBCZDN')).toBe('task_…CZDN')
    expect(shortenId('exe_01HQ8X6A1B2C3D4E5F6G7H8J9K')).toBe('exe_…8J9K')
  })

  it('leaves short or non-ULID ids alone', () => {
    expect(shortenId('agent_claude_code')).toBe('agent_claude_code')
    expect(shortenId('short')).toBe('short')
    expect(shortenId('')).toBe('')
  })

  it('falls back to head and tail for opaque ids', () => {
    expect(shortenId('abcdefghijklmnop')).toBe('abcdef…mnop')
  })
})

describe('formatDuration', () => {
  it('speaks in minutes once past a minute', () => {
    expect(formatDuration(134_000)).toBe('2m14s')
    expect(formatDuration(60_000)).toBe('1m00s')
  })

  it('keeps sub-minute runs in seconds', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_400)).toBe('45s')
  })

  it('switches to hours for long runs', () => {
    expect(formatDuration(3_720_000)).toBe('1h02m')
  })
})
