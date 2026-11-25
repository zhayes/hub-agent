import { createSignal, For, onCleanup } from 'solid-js'
import { Icon } from '../../components/ui/Icon'
import type { Locale, Translator } from '../../shared/i18n'
import type { ThemeController, ThemePreference } from '../../shared/theme'

export interface SettingsViewProps {
  theme: ThemeController
  locale: Locale
  t: Translator
  onLocale: (locale: Locale) => void
  token: string
  onSaveToken: (token: string) => void
}

const themeOptions: ThemePreference[] = ['system', 'light', 'dark']
const localeOptions: Locale[] = ['en-US', 'zh-CN']

export function SettingsView(props: SettingsViewProps) {
  const [token, setToken] = createSignal(props.token)
  const [saved, setSaved] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const save = (): void => {
    props.onSaveToken(token())
    setSaved(true)
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => setSaved(false), 2400)
  }

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return (
    <div class="settings-panel">
      <section class="settings-section">
        <div class="settings-label">
          <h2>{props.t('settingsAppearance')}</h2>
          <p class="muted">{props.t('appearanceHint')}</p>
        </div>
        <div class="settings-body">
          <fieldset class="segmented" aria-label={props.t('theme')}>
            <For each={themeOptions}>
              {(theme) => (
                <button
                  type="button"
                  class={`segment${props.theme.theme() === theme ? ' active' : ''}`}
                  aria-pressed={props.theme.theme() === theme ? 'true' : 'false'}
                  onClick={() => props.theme.setTheme(theme)}
                >
                  <Icon
                    name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'}
                    size={14}
                  />
                  {theme === 'system'
                    ? props.t('themeSystem')
                    : theme === 'light'
                      ? props.t('themeLight')
                      : props.t('themeDark')}
                </button>
              )}
            </For>
          </fieldset>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-label">
          <h2>{props.t('settingsLanguage')}</h2>
          <p class="muted">{props.t('languageHint')}</p>
        </div>
        <div class="settings-body">
          <fieldset class="segmented" aria-label={props.t('language')}>
            <For each={localeOptions}>
              {(locale) => (
                <button
                  type="button"
                  class={`segment${props.locale === locale ? ' active' : ''}`}
                  aria-pressed={props.locale === locale ? 'true' : 'false'}
                  onClick={() => props.onLocale(locale)}
                >
                  <Icon name="globe" size={14} />
                  {locale === 'en-US' ? props.t('languageEnglish') : props.t('languageChinese')}
                </button>
              )}
            </For>
          </fieldset>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-label">
          <h2>{props.t('settingsConnection')}</h2>
          <p class="muted">{props.t('connectionHint')}</p>
        </div>
        <div class="settings-body">
          <label class="field-label" for="settings-token">
            {props.t('settingsToken')}
          </label>
          <div class="field-row">
            <input
              id="settings-token"
              class="text-input"
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={token()}
              placeholder={props.t('apiTokenHint')}
              onInput={(event) => setToken(event.currentTarget.value)}
            />
            <button type="button" class="solid-button" onClick={save}>
              {props.t('save')}
            </button>
          </div>
          <p class={`field-hint${saved() ? ' is-saved' : ''}`} aria-live="polite">
            {saved()
              ? props.t('settingsSaved')
              : props.token === ''
                ? props.t('tokenMissing')
                : props.t('tokenStored')}
          </p>
        </div>
      </section>
    </div>
  )
}
