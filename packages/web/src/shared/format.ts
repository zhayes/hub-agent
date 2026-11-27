import { formatDateTime, formatRelativeTime, type Locale } from './i18n'

export function absoluteTime(locale: Locale, iso: string): string {
  return formatDateTime(locale, iso)
}

export function relativeTime(locale: Locale, iso: string): string {
  return formatRelativeTime(locale, iso)
}

export function shortenId(id: string): string {
  const underscore = id.lastIndexOf('_')
  if (underscore === -1) {
    return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
  }
  const tail = id.slice(underscore + 1)
  if (tail.length < 12) return id
  return `${id.slice(0, underscore)}_…${tail.slice(-4)}`
}

/**
 * 时长：给人看的一段（2m14s / 45s / 1h02m），不是时钟。
 * 任务页用它回答“这一次跑了多久”，所以短于 1 秒也要说出口。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
