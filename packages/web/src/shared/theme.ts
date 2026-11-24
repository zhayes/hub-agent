import { createSignal, onCleanup, onSettled } from 'solid-js'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'hubagent.theme'
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function normalizeTheme(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function nextTheme(value: ThemePreference): ThemePreference {
  const index = THEMES.indexOf(value)
  return THEMES[(index + 1) % THEMES.length] ?? 'system'
}

export function themeMetaContent(value: ThemePreference): 'light dark' | 'light' | 'dark' {
  return value === 'system' ? 'light dark' : value
}

export function readStoredTheme(storage?: Storage): ThemePreference {
  try {
    return normalizeTheme((storage ?? globalThis.localStorage).getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function writeStoredTheme(value: ThemePreference, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage
    if (value === 'system') target.removeItem(STORAGE_KEY)
    else target.setItem(STORAGE_KEY, value)
  } catch {
    // Storage can be blocked; theme still applies for this session.
  }
}

export function applyTheme(value: ThemePreference, documentRef: Document = document): void {
  const meta = documentRef.querySelector('meta[name="color-scheme"]')
  if (meta !== null) meta.setAttribute('content', themeMetaContent(value))
}

export interface ThemeController {
  theme: () => ThemePreference
  setTheme: (value: ThemePreference) => void
  cycleTheme: () => ThemePreference
}

export function createTheme(): ThemeController {
  const [theme, setThemeSignal] = createSignal<ThemePreference>(readStoredTheme())
  const setTheme = (value: ThemePreference): void => {
    setThemeSignal(value)
    applyTheme(value)
    writeStoredTheme(value)
  }

  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  const onChange = (): void => {
    // CSS follows the system when preference is "system"; no class is needed.
    if (theme() === 'system') applyTheme('system')
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) {
      const next = normalizeTheme(event.newValue)
      setThemeSignal(next)
      applyTheme(next)
    }
  }

  onSettled(() => {
    applyTheme(theme())
    media?.addEventListener('change', onChange)
    globalThis.addEventListener('storage', onStorage)
  })
  onCleanup(() => {
    media?.removeEventListener('change', onChange)
    globalThis.removeEventListener('storage', onStorage)
  })

  return {
    theme,
    setTheme,
    cycleTheme: () => {
      const next = nextTheme(theme())
      setTheme(next)
      return next
    },
  }
}
