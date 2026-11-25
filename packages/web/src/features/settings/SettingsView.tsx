import { createSignal, For, onCleanup } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { Field, fieldControl } from '../../components/ui/Field'
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

const section =
  'grid grid-cols-[minmax(0,300px)_minmax(0,1fr)] gap-6 border-b border-line py-[22px] max-[1100px]:grid-cols-[minmax(0,240px)_minmax(0,1fr)] max-[860px]:grid-cols-1 max-[860px]:gap-2.5'

/* No preflight, so the fieldset's UA border/margin/padding must be reset here. */
const segmented =
  'm-0 inline-flex w-fit items-center gap-0.5 rounded-control border-0 bg-subtle p-0.5'

const segment =
  'inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-control px-3 text-meta text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

const segmentActive = 'bg-surface font-medium text-ink'

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
    <div class="max-w-[980px] pb-8">
      <section class={section}>
        <div>
          <h2 class="text-section text-ink">{props.t('settingsAppearance')}</h2>
          <p class="mt-1 text-meta text-ink-2">{props.t('appearanceHint')}</p>
        </div>
        <div class="flex flex-col gap-2">
          <fieldset class={segmented} aria-label={props.t('theme')}>
            <For each={themeOptions}>
              {(theme) => (
                <button
                  type="button"
                  class={`${segment} ${props.theme.theme() === theme ? segmentActive : ''}`}
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

      <section class={section}>
        <div>
          <h2 class="text-section text-ink">{props.t('settingsLanguage')}</h2>
          <p class="mt-1 text-meta text-ink-2">{props.t('languageHint')}</p>
        </div>
        <div class="flex flex-col gap-2">
          <fieldset class={segmented} aria-label={props.t('language')}>
            <For each={localeOptions}>
              {(locale) => (
                <button
                  type="button"
                  class={`${segment} ${props.locale === locale ? segmentActive : ''}`}
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

      <section class={section}>
        <div>
          <h2 class="text-section text-ink">{props.t('settingsConnection')}</h2>
          <p class="mt-1 text-meta text-ink-2">{props.t('connectionHint')}</p>
        </div>
        <div class="flex flex-col gap-2">
          <Field label={props.t('settingsToken')}>
            {(control) => (
              <>
                <div class="flex items-center gap-2">
                  <input
                    id={control.id}
                    aria-describedby={`${control.id}-status`}
                    class={`${fieldControl} min-w-0 flex-1`}
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    value={token()}
                    placeholder={props.t('apiTokenHint')}
                    onInput={(event) => setToken(event.currentTarget.value)}
                  />
                  <Button onClick={save}>{props.t('save')}</Button>
                </div>
                <p
                  id={`${control.id}-status`}
                  class={`text-badge ${saved() ? 'text-success' : 'text-ink-3'}`}
                  aria-live="polite"
                >
                  {saved()
                    ? props.t('settingsSaved')
                    : props.token === ''
                      ? props.t('tokenMissing')
                      : props.t('tokenStored')}
                </p>
              </>
            )}
          </Field>
        </div>
      </section>
    </div>
  )
}
