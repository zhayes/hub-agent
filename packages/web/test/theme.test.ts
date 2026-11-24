import { describe, expect, it } from 'vitest'
import {
  applyTheme,
  nextTheme,
  normalizeTheme,
  readStoredTheme,
  themeMetaContent,
  writeStoredTheme,
} from '../src/shared/theme'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe('theme', () => {
  it('normalizes unknown values to system and cycles system -> light -> dark', () => {
    expect(normalizeTheme(null)).toBe('system')
    expect(normalizeTheme('sepia')).toBe('system')
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })

  it('maps preference to color-scheme meta content', () => {
    expect(themeMetaContent('system')).toBe('light dark')
    expect(themeMetaContent('light')).toBe('light')
    expect(themeMetaContent('dark')).toBe('dark')
  })

  it('persists explicit values and removes the key for system', () => {
    const storage = memoryStorage({ 'hubagent.theme': 'light' })
    expect(readStoredTheme(storage)).toBe('light')
    writeStoredTheme('dark', storage)
    expect(storage.getItem('hubagent.theme')).toBe('dark')
    writeStoredTheme('system', storage)
    expect(storage.getItem('hubagent.theme')).toBeNull()
    expect(readStoredTheme(storage)).toBe('system')
  })

  it('writes meta content without relying on a class', () => {
    const meta = { content: 'light dark', setAttribute: (_name: string, value: string) => { meta.content = value } }
    const doc = { querySelector: () => meta } as unknown as Document
    applyTheme('dark', doc)
    expect(meta.content).toBe('dark')
    applyTheme('system', doc)
    expect(meta.content).toBe('light dark')
  })
})
