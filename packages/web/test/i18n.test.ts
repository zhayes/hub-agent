import { describe, expect, it } from 'vitest'
import {
  detectLocale,
  formatDateTime,
  formatRelativeTime,
  isLocale,
  messageKeys,
  statusKey,
  translate,
} from '../src/shared/i18n'

describe('i18n', () => {
  it('detects zh/en and falls back to en-US', () => {
    expect(detectLocale(['zh-CN', 'en-US'])).toBe('zh-CN')
    expect(detectLocale(['en-GB'])).toBe('en-US')
    expect(detectLocale(['fr-FR'])).toBe('en-US')
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('fr-FR')).toBe(false)
  })

  it('has a complete dictionary for every key', () => {
    for (const key of messageKeys) {
      expect(translate('en-US', key).length).toBeGreaterThan(0)
      expect(translate('zh-CN', key).length).toBeGreaterThan(0)
    }
  })

  it('interpolates params and translates statuses', () => {
    expect(translate('en-US', 'commandExit', { code: 0 })).toBe('exit 0')
    expect(translate('zh-CN', 'commandExit', { code: 0 })).toBe('退出码 0')
    expect(translate('en-US', 'statusRunning')).toBe('running')
    expect(statusKey('waiting_approval')).toBe('statusWaitingOnYou')
    expect(statusKey('waiting_input')).toBe('statusWaitingInput')
    expect(statusKey('succeeded')).toBe('statusCompleted')
    expect(statusKey('idle')).toBe('statusIdle')
    expect(statusKey('offline')).toBe('statusOffline')
    expect(statusKey('pending')).toBe('statusPending')
    expect(statusKey('pass')).toBe('statusPass')
    expect(statusKey('not-a-status')).toBe('unknown')
  })

  it('formats dates and relative time with Intl', () => {
    expect(formatDateTime('en-US', '2026-11-24T08:00:00.000Z')).toMatch(/2026/)
    expect(formatRelativeTime('en-US', new Date(Date.now() - 60_000).toISOString())).toMatch(
      /minute/,
    )
  })
})
