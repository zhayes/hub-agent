/**
 * Known endpoints for the "add provider" dialog.
 *
 * Only fields Pi actually reads are filled in. Model ids are deliberately
 * conservative: they are prefill, not a catalogue, and the user can overwrite
 * them. `custom` is the escape hatch for anything self-hosted.
 */
export interface ModelPreset {
  id: string
  /** Shown in the preset picker; `custom` resolves to t('modelCustom'). */
  label: string
  providerName: string
  baseUrl: string
  api: string
  modelId: string
  /** Local endpoints need *a* key, not a real one. */
  apiKey?: string
  custom: boolean
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    modelId: 'deepseek-chat',
    custom: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    providerName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    modelId: 'gpt-4o',
    custom: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    providerName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    modelId: 'claude-sonnet-4-5',
    custom: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    providerName: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    modelId: '',
    apiKey: 'ollama',
    custom: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    providerName: '',
    baseUrl: '',
    api: 'openai-completions',
    modelId: '',
    custom: true,
  },
]

export function presetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id)
}

/** A provider id is "custom" when no preset claims it. */
export function isCustomProvider(providerId: string): boolean {
  return !MODEL_PRESETS.some((preset) => !preset.custom && preset.id === providerId)
}

/** The provider we suggest when nothing is configured yet. */
export const SUGGESTED_PRESET = MODEL_PRESETS[0] as ModelPreset
