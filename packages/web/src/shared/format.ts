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
