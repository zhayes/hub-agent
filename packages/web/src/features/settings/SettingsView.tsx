import { createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field, fieldControl } from '../../components/ui/Field'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { SelectInput, type SelectOption } from '../../components/ui/SelectInput'
import { TextInput } from '../../components/ui/TextInput'
import { toast } from '../../components/ui/Toaster'
import { type ModelConfigView, type ProviderSummary, settingsApi } from '../../shared/api'
import type { Locale, Translator } from '../../shared/i18n'
import type { ThemeController, ThemePreference } from '../../shared/theme'
import {
  isCustomProvider,
  MODEL_PRESETS,
  type ModelPreset,
  presetById,
  SUGGESTED_PRESET,
} from './model-presets'

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
const cardRow =
  'flex items-center justify-between gap-3 rounded-panel border border-line px-4 py-3 transition-colors hover:border-line-strong'
const badge = 'shrink-0 rounded-control px-1.5 py-0.5 text-badge'
const badgeNeutral = `${badge} bg-subtle text-ink-3`
const badgeAccent = `${badge} bg-accent-soft text-accent`
const addRow =
  'flex w-full items-center justify-center gap-2 rounded-panel border border-dashed border-line-strong py-3 text-meta text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export function SettingsView(props: SettingsViewProps) {
  const [token, setToken] = createSignal(props.token)
  const [saved, setSaved] = createSignal(false)

  const [model, setModel] = createSignal<ModelConfigView>()
  const [providers, setProviders] = createSignal<ProviderSummary[]>([])
  const [listError, setListError] = createSignal('')

  /* 编辑器：`editingId === ''` 表示新增。 */
  const [editorOpen, setEditorOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal('')
  const [providerId, setProviderId] = createSignal('')
  const [providerName, setProviderName] = createSignal('')
  const [baseUrl, setBaseUrl] = createSignal('')
  const [apiName, setApiName] = createSignal<string>(apiOptions[0])
  const [modelId, setModelId] = createSignal('')
  const [apiKey, setApiKey] = createSignal('')
  const [keySet, setKeySet] = createSignal(false)
  const [keyCleared, setKeyCleared] = createSignal(false)
  const [revealKey, setRevealKey] = createSignal(false)
  const [contextWindow, setContextWindow] = createSignal('')
  const [maxTokens, setMaxTokens] = createSignal('')
  const [thinkingLevel, setThinkingLevel] = createSignal('')
  const [makeDefault, setMakeDefault] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal('')
  const [saveDetail, setSaveDetail] = createSignal('')

  const [deleteTarget, setDeleteTarget] = createSignal<ProviderSummary>()
  const [deleting, setDeleting] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal('')

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

  const apply = (next: { model: ModelConfigView; providers: ProviderSummary[] }): void => {
    setModel(next.model)
    setProviders(next.providers)
    setListError('')
  }

  const load = async (): Promise<void> => {
    try {
      apply(await settingsApi.model())
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onSettled(() => {
    void load()
  })

  const keyHint = (): string => {
    if (!keySet() || keyCleared()) return props.t('modelApiKeyUnset')
    return props.t('modelApiKeySet')
  }

  const fillPreset = (preset: ModelPreset): void => {
    /* 只在新增时整体覆盖，编辑已有 provider 时切预设没有意义。 */
    if (preset.custom) {
      setProviderId('')
      setProviderName('')
      setBaseUrl('')
      setModelId('')
      return
    }
    setProviderId(preset.id)
    setProviderName(preset.providerName)
    setBaseUrl(preset.baseUrl)
    setApiName(preset.api)
    setModelId(preset.modelId)
    if (preset.apiKey !== undefined) setApiKey(preset.apiKey)
  }

  const resetEditor = (): void => {
    setProviderId('')
    setProviderName('')
    setBaseUrl('')
    setApiName(apiOptions[0])
    setModelId('')
    setApiKey('')
    setKeySet(false)
    setKeyCleared(false)
    setRevealKey(false)
    setContextWindow('')
    setMaxTokens('')
    setThinkingLevel('')
    setSaveError('')
    setSaveDetail('')
  }

  const openAdd = (preset: ModelPreset = SUGGESTED_PRESET): void => {
    setEditingId('')
    resetEditor()
    setMakeDefault(providers().length === 0)
    fillPreset(preset)
    setEditorOpen(true)
  }

  const openEdit = (provider: ProviderSummary): void => {
    setEditingId(provider.providerId)
    resetEditor()
    setProviderId(provider.providerId)
    setProviderName(provider.name ?? '')
    setBaseUrl(provider.baseUrl ?? '')
    setApiName(provider.api ?? apiOptions[0])
    setModelId(provider.modelId ?? '')
    setKeySet(provider.apiKeySet)
    setContextWindow(provider.contextWindow === undefined ? '' : String(provider.contextWindow))
    setMaxTokens(provider.maxTokens === undefined ? '' : String(provider.maxTokens))
    setThinkingLevel(provider.thinkingLevel ?? '')
    setMakeDefault(provider.isDefault)
    setEditorOpen(true)
  }

  /* 数字字段留空 = 不写该字段（沿用 Pi 默认），非法值直接拦在本地。 */
  const parseCount = (raw: string): number | null | undefined => {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const value = Number(trimmed)
    return Number.isInteger(value) && value > 0 ? value : null
  }

  const submit = async (): Promise<void> => {
    if (saving()) return
    setSaveError('')
    setSaveDetail('')
    const id = providerId().trim()
    const value = modelId().trim()
    if (id === '' || value === '') {
      setSaveError(props.t('modelRequired'))
      return
    }

    const context = parseCount(contextWindow())
    const tokens = parseCount(maxTokens())
    if (context === null || tokens === null) {
      setSaveError(props.t('modelRequired'))
      return
    }

    setSaving(true)
    try {
      const result = await settingsApi.saveModel({
        providerId: id,
        modelId: value,
        providerName: providerName().trim(),
        baseUrl: baseUrl().trim(),
        api: apiName(),
        makeDefault: makeDefault(),
        ...(context === undefined ? {} : { contextWindow: context }),
        ...(tokens === undefined ? {} : { maxTokens: tokens }),
        thinkingLevel: makeDefault() && thinkingLevel() !== '' ? thinkingLevel() : null,
        ...(keyCleared() ? { apiKey: '' } : apiKey() === '' ? {} : { apiKey: apiKey() }),
      })
      apply(result)
      setEditorOpen(false)
      toast(props.t('settingsSaved'))
    } catch (cause) {
      setSaveError(props.t('modelSaveFailed'))
      setSaveDetail(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget()
    if (target === undefined || deleting()) return
    setDeleteError('')
    setDeleting(true)
    try {
      apply(await settingsApi.deleteProvider(target.providerId))
      setDeleteTarget(undefined)
      toast(`${target.name ?? target.providerId} · ${props.t('modelDelete')}`)
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  const presetOptions = (): SelectOption[] =>
    MODEL_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.custom ? props.t('modelCustom') : preset.label,
    }))

  const apiSelectOptions = (): SelectOption[] =>
    apiOptions.map((api) => ({ value: api, label: api }))

  const thinkingSelectOptions = (): SelectOption[] =>
    thinkingOptions.map((level) => ({
      value: level,
      label: level === '' ? props.t('modelThinkingDefault') : level,
    }))

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
        <div class="flex max-w-[520px] flex-col gap-2">
          <Show
            when={listError() === ''}
            fallback={<p class="text-badge text-danger">{props.t('modelSaveFailed')}</p>}
          >
            <Show when={providers().length === 0}>
              {/* 空列表给一个建议项：点「配置」就把 DeepSeek 预填进表单。 */}
              <div class={cardRow}>
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-body font-medium text-ink">
                    {SUGGESTED_PRESET.label}
                  </span>
                  <span class="inline-block size-2 shrink-0 rounded-full bg-line-strong" />
                  <span class="visually-hidden">{props.t('modelApiKeyUnset')}</span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => openAdd()}>
                  {props.t('modelConfigure')}
                </Button>
              </div>
            </Show>

            <For each={providers()}>
              {(provider) => (
                <div class={cardRow}>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-body font-medium text-ink">
                        {provider.name ?? provider.providerId}
                      </span>
                      <Show when={isCustomProvider(provider.providerId)}>
                        <span class={badgeNeutral}>{props.t('modelCustom')}</span>
                      </Show>
                      <Show when={provider.isDefault}>
                        <span class={badgeAccent}>{props.t('modelDefault')}</span>
                      </Show>
                      <span
                        class={`inline-block size-2 shrink-0 rounded-full ${
                          provider.apiKeySet ? 'bg-success' : 'bg-line-strong'
                        }`}
                      />
                      <span class="visually-hidden">
                        {provider.apiKeySet
                          ? props.t('modelApiKeySet')
                          : props.t('modelApiKeyUnset')}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate font-mono text-badge text-ink-3">
                      {provider.providerId}
                      {provider.modelId === undefined ? '' : ` · ${provider.modelId}`}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(provider)}>
                      {props.t('modelEdit')}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => {
                        setDeleteError('')
                        setDeleteTarget(provider)
                      }}
                    >
                      {props.t('modelDelete')}
                    </Button>
                  </div>
                </div>
              )}
            </For>

            <button type="button" class={addRow} onClick={() => openAdd()}>
              <Icon name="plus" size={14} />
              {props.t('modelAddProvider')}
            </button>
          </Show>
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

      <Dialog
        open={editorOpen()}
        onClose={() => setEditorOpen(false)}
        title={editingId() === '' ? props.t('modelAddProvider') : props.t('modelEdit')}
        closeLabel={props.t('close')}
      >
        <form
          class="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Show when={editingId() === ''}>
            <Field label={props.t('modelPreset')}>
              {(control) => (
                <SelectInput
                  {...control}
                  value={MODEL_PRESETS.find((preset) => preset.id === providerId())?.id ?? 'custom'}
                  onChange={(value) => {
                    const preset = presetById(value)
                    if (preset !== undefined) fillPreset(preset)
                  }}
                  options={presetOptions()}
                />
              )}
            </Field>
          </Show>

          <div class={twoUp}>
            <Field label={props.t('modelProvider')}>
              {(control) => (
                <TextInput
                  {...control}
                  mono
                  autofocus
                  value={providerId()}
                  placeholder="deepseek"
                  onInput={setProviderId}
                />
              )}
            </Field>
            <Field label={props.t('modelName')}>
              {(control) => (
                <TextInput
                  {...control}
                  value={providerName()}
                  placeholder="DeepSeek"
                  onInput={setProviderName}
                />
              )}
            </Field>
          </div>

          <Field label={props.t('modelBaseUrl')}>
            {(control) => (
              <TextInput
                {...control}
                mono
                value={baseUrl()}
                inputmode="url"
                placeholder="https://api.deepseek.com/v1"
                onInput={setBaseUrl}
              />
            )}
          </Field>

          <div class={twoUp}>
            <Field label={props.t('modelApi')}>
              {(control) => (
                <SelectInput
                  {...control}
                  value={apiName()}
                  onChange={setApiName}
                  options={apiSelectOptions()}
                />
              )}
            </Field>
            <Field label={props.t('modelModelId')}>
              {(control) => (
                <TextInput
                  {...control}
                  mono
                  value={modelId()}
                  placeholder="deepseek-chat"
                  onInput={setModelId}
                />
              )}
            </Field>
          </div>

          <Field label={props.t('modelApiKey')} hint={keyHint()}>
            {(control) => (
              <div class="flex items-center gap-1.5">
                <TextInput
                  {...control}
                  class="min-w-0 flex-1"
                  type={revealKey() ? 'text' : 'password'}
                  value={apiKey()}
                  onInput={(value) => {
                    setKeyCleared(false)
                    setApiKey(value)
                  }}
                />
                <IconButton
                  icon={revealKey() ? 'eyeOff' : 'eye'}
                  label={props.t(revealKey() ? 'hideSecret' : 'showSecret')}
                  onClick={() => setRevealKey((value) => !value)}
                />
                <Show when={keySet() && !keyCleared()}>
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
                <TextInput
                  {...control}
                  value={contextWindow()}
                  inputmode="numeric"
                  placeholder="128000"
                  onInput={setContextWindow}
                />
              )}
            </Field>
            <Field label={props.t('modelMaxTokens')}>
              {(control) => (
                <TextInput
                  {...control}
                  value={maxTokens()}
                  inputmode="numeric"
                  placeholder="16384"
                  onInput={setMaxTokens}
                />
              )}
            </Field>
          </div>

          <Field label={props.t('modelThinking')}>
            {(control) => (
              <SelectInput
                {...control}
                value={thinkingLevel()}
                onChange={setThinkingLevel}
                options={thinkingSelectOptions()}
              />
            )}
          </Field>

          <label class="flex items-center gap-2 text-meta text-ink-2">
            <input
              type="checkbox"
              class="size-3.5 accent-[var(--hx-accent)]"
              checked={makeDefault()}
              onChange={(event) => setMakeDefault(event.currentTarget.checked)}
            />
            {props.t('modelDefault')}
          </label>

          <div class="flex items-center justify-end gap-2 border-t border-line pt-3">
            <Show when={saveError() !== ''}>
              <p class="mr-auto text-badge text-danger" role="alert" title={saveDetail()}>
                {saveError()}
              </p>
            </Show>
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>
              {props.t('cancel')}
            </Button>
            <Button type="submit" disabled={saving()}>
              {props.t('save')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleteTarget() !== undefined}
        onClose={() => setDeleteTarget(undefined)}
        title={props.t('modelDeleteTitle')}
        closeLabel={props.t('close')}
      >
        <div class="flex flex-col gap-3">
          <p class="text-meta text-ink-2">
            {props.t('modelDeleteBody', {
              name: deleteTarget()?.name ?? deleteTarget()?.providerId ?? '',
            })}
          </p>
          <Show when={deleteError() !== ''}>
            <p class="text-badge text-danger" role="alert" title={deleteError()}>
              {props.t('modelDeleteFailed')}
            </p>
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(undefined)}>
              {props.t('cancel')}
            </Button>
            <Button variant="danger" disabled={deleting()} onClick={() => void confirmDelete()}>
              {props.t('modelDelete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
