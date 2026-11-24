import { createSignal, For } from 'solid-js'
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
  return (
    <div class="settings-panel">
      <section class="settings-section">
        <div class="section-heading">
          <span>{props.t('settingsAppearance')}</span>
        </div>
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
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <span>{props.t('settingsLanguage')}</span>
        </div>
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
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <span>{props.t('settingsConnection')}</span>
        </div>
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
          <button type="button" class="solid-button" onClick={() => props.onSaveToken(token())}>
            {props.t('save')}
          </button>
        </div>
      </section>
    </div>
  )
}
