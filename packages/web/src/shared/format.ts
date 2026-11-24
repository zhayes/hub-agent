import { formatDateTime, formatRelativeTime, type Locale } from './i18n'

export function absoluteTime(locale: Locale, iso: string): string {
  return formatDateTime(locale, iso)
}

export function relativeTime(locale: Locale, iso: string): string {
  return formatRelativeTime(locale, iso)
}

export function shortenId(id: string, length = 8): string {
  return id.length > length ? id.slice(-length) : id
}
