import { createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { Field, fieldControl } from '../../components/ui/Field'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { toast } from '../../components/ui/Toaster'
import { type ModelConfigView, settingsApi } from '../../shared/api'
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
/** Pi 认识的四种 API 协议（models.json 的 `api` 字段）。 */
const apiOptions = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
/** 空字符串 = 不写 defaultThinkingLevel，沿用模型默认。 */
const thinkingOptions = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const section =
  'grid grid-cols-[minmax(0,300px)_minmax(0,1fr)] gap-6 border-b border-line py-[22px] max-[1100px]:grid-cols-[minmax(0,240px)_minmax(0,1fr)] max-[860px]:grid-cols-1 max-[860px]:gap-2.5'

/* No preflight, so the fieldset's UA border/margin/padding must be reset here. */
const segmented =
  'm-0 inline-flex w-fit items-center gap-0.5 rounded-control border-0 bg-subtle p-0.5'

const segment =
  'inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-control px-3 text-meta text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

const segmentActive = 'bg-surface font-medium text-ink'

const twoUp = 'grid grid-cols-2 gap-3 max-[560px]:grid-cols-1'

export function SettingsView(props: SettingsViewProps) {
  const [token, setToken] = createSignal(props.token)
  const [saved, setSaved] = createSignal(false)

  const [model, setModel] = createSignal<ModelConfigView>()
  const [providerId, setProviderId] = createSignal('')
  const [modelId, setModelId] = createSignal('')
  const [baseUrl, setBaseUrl] = createSignal('')
  const [apiName, setApiName] = createSignal<string>(apiOptions[0])
  const [apiKey, setApiKey] = createSignal('')
  const [revealKey, setRevealKey] = createSignal(false)
  /* 用户点过「Clear key」：下次保存时发空串把 key 删掉，而不是保留旧值。 */
  const [keyCleared, setKeyCleared] = createSignal(false)
  const [contextWindow, setContextWindow] = createSignal('')
  const [maxTokens, setMaxTokens] = createSignal('')
  const [thinkingLevel, setThinkingLevel] = createSignal('')
  const [modelBusy, setModelBusy] = createSignal(false)
  const [modelError, setModelError] = createSignal('')
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

  const apply = (view: ModelConfigView | undefined): void => {
    setModel(view)
    setProviderId(view?.providerId ?? '')
    setModelId(view?.modelId ?? '')
    setBaseUrl(view?.baseUrl ?? '')
    setApiName(view?.api ?? apiOptions[0])
    setContextWindow(view?.contextWindow === undefined ? '' : String(view.contextWindow))
    setMaxTokens(view?.maxTokens === undefined ? '' : String(view.maxTokens))
    setThinkingLevel(view?.thinkingLevel ?? '')
    setApiKey('')
    setKeyCleared(false)
  }

  const loadModel = async (): Promise<void> => {
    try {
      const result = await settingsApi.model()
      apply(result.model)
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onSettled(() => {
    void loadModel()
  })

  const keyConfigured = (): boolean => !keyCleared() && model()?.apiKeySet === true

  const keyHint = (): string => {
    if (!keyConfigured()) return props.t('modelApiKeyUnset')
    const hint = model()?.apiKeyHint
    return hint === undefined ? props.t('modelApiKeySet') : `${props.t('modelApiKeySet')} · ${hint}`
  }

  /* 数字字段留空 = 不写该字段（沿用 Pi 默认），非法值直接拦在本地。 */
  const parseCount = (raw: string): number | null | undefined => {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const value = Number(trimmed)
    return Number.isInteger(value) && value > 0 ? value : null
  }

  const saveModel = async (): Promise<void> => {
    if (modelBusy()) return
    setModelError('')
    const provider = providerId().trim()
    const id = modelId().trim()
    if (provider === '' || id === '') return

    const context = parseCount(contextWindow())
    const tokens = parseCount(maxTokens())
    if (context === null || tokens === null) {
      setModelError(props.t('modelSaveFailed'))
      return
    }

    setModelBusy(true)
    try {
      const result = await settingsApi.saveModel({
        providerId: provider,
        modelId: id,
        baseUrl: baseUrl().trim(),
        api: apiName(),
        ...(context === undefined ? {} : { contextWindow: context }),
        ...(tokens === undefined ? {} : { maxTokens: tokens }),
        thinkingLevel: thinkingLevel() === '' ? null : thinkingLevel(),
        ...(keyCleared() ? { apiKey: '' } : apiKey() === '' ? {} : { apiKey: apiKey() }),
      })
      apply(result.model)
      toast(props.t('settingsSaved'))
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setModelBusy(false)
    }
  }

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
          <h2 class="text-section text-ink">{props.t('settingsModel')}</h2>
          <p class="mt-1 text-meta text-ink-2">{props.t('modelHint')}</p>
          <Show when={model()?.agentDir !== undefined}>
            <p class="mt-1 truncate font-mono text-badge text-ink-3" title={model()?.agentDir}>
              {model()?.agentDir}
            </p>
          </Show>
        </div>
        <form
          class="flex max-w-[440px] flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void saveModel()
          }}
        >
          <div class={twoUp}>
            <Field label={props.t('modelProvider')}>
              {(control) => (
                <input
                  id={control.id}
                  class={fieldControl}
                  type="text"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="local-proxy"
                  value={providerId()}
                  onInput={(event) => setProviderId(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field label={props.t('modelModelId')}>
              {(control) => (
                <input
                  id={control.id}
                  class={fieldControl}
                  type="text"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="qwen2.5-coder:7b"
                  value={modelId()}
                  onInput={(event) => setModelId(event.currentTarget.value)}
                />
              )}
            </Field>
          </div>

          <Field label={props.t('modelBaseUrl')}>
            {(control) => (
              <input
                id={control.id}
                class={fieldControl}
                type="text"
                spellcheck={false}
                autocomplete="off"
                inputmode="url"
                placeholder="http://127.0.0.1:11434/v1"
                value={baseUrl()}
                onInput={(event) => setBaseUrl(event.currentTarget.value)}
              />
            )}
          </Field>

          <div class={twoUp}>
            <Field label={props.t('modelApi')}>
              {(control) => (
                <select
                  id={control.id}
                  class={fieldControl}
                  value={apiName()}
                  onChange={(event) => setApiName(event.currentTarget.value)}
                >
                  <For each={apiOptions}>
                    {(option) => <option value={option}>{option}</option>}
                  </For>
                </select>
              )}
            </Field>
            <Field label={props.t('modelThinking')}>
              {(control) => (
                <select
                  id={control.id}
                  class={fieldControl}
                  value={thinkingLevel()}
                  onChange={(event) => setThinkingLevel(event.currentTarget.value)}
                >
                  <For each={thinkingOptions}>
                    {(option) => (
                      <option value={option}>
                        {option === '' ? props.t('modelThinkingDefault') : option}
                      </option>
                    )}
                  </For>
                </select>
              )}
            </Field>
          </div>

          <Field label={props.t('modelApiKey')} hint={keyHint()}>
            {(control) => (
              <div class="flex items-center gap-1.5">
                <input
                  id={control.id}
                  aria-describedby={control['aria-describedby']}
                  class={`${fieldControl} min-w-0 flex-1`}
                  type={revealKey() ? 'text' : 'password'}
                  autocomplete="off"
                  spellcheck={false}
                  placeholder=""
                  value={apiKey()}
                  onInput={(event) => {
                    setKeyCleared(false)
                    setApiKey(event.currentTarget.value)
                  }}
                />
                <IconButton
                  icon={revealKey() ? 'eyeOff' : 'eye'}
                  label={props.t(revealKey() ? 'hide' : 'show')}
                  onClick={() => setRevealKey((value) => !value)}
                />
                <Show when={keyConfigured()}>
                  <IconButton
                    icon="x"
                    label={props.t('modelClearKey')}
                    onClick={() => {
                      setKeyCleared(true)
                      setApiKey('')
                    }}
                  />
                </Show>
              </div>
            )}
          </Field>

          <div class={twoUp}>
            <Field label={props.t('modelContextWindow')}>
              {(control) => (
                <input
                  id={control.id}
                  class={fieldControl}
                  type="text"
                  inputmode="numeric"
                  placeholder="128000"
                  value={contextWindow()}
                  onInput={(event) => setContextWindow(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field label={props.t('modelMaxTokens')}>
              {(control) => (
                <input
                  id={control.id}
                  class={fieldControl}
                  type="text"
                  inputmode="numeric"
                  placeholder="16384"
                  value={maxTokens()}
                  onInput={(event) => setMaxTokens(event.currentTarget.value)}
                />
              )}
            </Field>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <Button
              type="submit"
              disabled={modelBusy() || providerId().trim() === '' || modelId().trim() === ''}
            >
              {props.t('save')}
            </Button>
            <Show when={modelError() !== ''}>
              <p class="text-badge text-danger" role="alert" title={modelError()}>
                {props.t('modelSaveFailed')}
              </p>
            </Show>
          </div>
        </form>
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
