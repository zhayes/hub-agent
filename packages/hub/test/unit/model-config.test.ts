import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseModelPatch,
  readModelConfig,
  writeModelConfig,
} from '../../src/runtime/model-config/model-config'
import { HubError } from '../../src/shared/errors'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hubagent-model-'))
}

const basePatch = {
  providerId: 'local-proxy',
  modelId: 'qwen2.5-coder:7b',
  baseUrl: 'http://127.0.0.1:11434/v1',
  api: 'openai-completions',
  apiKey: 'sk-test-1234abcd',
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingLevel: 'low',
} as const

describe('readModelConfig', () => {
  it('没有配置文件时返回空视图，不抛错', () => {
    const view = readModelConfig(tempDir())
    expect(view.apiKeySet).toBe(false)
    expect(view.apiKeyKind).toBe('none')
    expect(view.providerId).toBeUndefined()
    expect(view.modelId).toBeUndefined()
  })

  it('永不回传明文 key，只给后 4 位', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const view = readModelConfig(dir)
    expect(view.apiKeySet).toBe(true)
    expect(view.apiKeyKind).toBe('literal')
    expect(view.apiKeyHint).toBe('…abcd')
    expect(JSON.stringify(view)).not.toContain('sk-test-1234abcd')
  })

  it('$ENV / !command 形态标记来源，且不给 key 提示', () => {
    const dir = tempDir()
    writeModelConfig(dir, { providerId: 'p1', modelId: 'm1', apiKey: '$OPENAI_API_KEY' })
    expect(readModelConfig(dir).apiKeyKind).toBe('env')

    writeModelConfig(dir, { providerId: 'p1', modelId: 'm1', apiKey: '!op read op://x/key' })
    const command = readModelConfig(dir)
    expect(command.apiKeyKind).toBe('command')
    expect(command.apiKeyHint).toBeUndefined()
  })
})

describe('writeModelConfig', () => {
  it('写入后能读回全部字段', () => {
    const dir = tempDir()
    const view = writeModelConfig(dir, basePatch)
    expect(view.providerId).toBe('local-proxy')
    expect(view.modelId).toBe('qwen2.5-coder:7b')
    expect(view.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(view.api).toBe('openai-completions')
    expect(view.contextWindow).toBe(128000)
    expect(view.maxTokens).toBe(16384)
    expect(view.thinkingLevel).toBe('low')
  })

  it('省略 apiKey 时保留旧 key', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const view = writeModelConfig(dir, {
      providerId: 'local-proxy',
      modelId: 'qwen2.5-coder:7b',
      baseUrl: 'https://proxy.example.com/v1',
    })
    expect(view.apiKeyHint).toBe('…abcd')
    expect(view.baseUrl).toBe('https://proxy.example.com/v1')
  })

  it("apiKey 传 '' 表示删除，回落到无 key", () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const view = writeModelConfig(dir, {
      providerId: 'local-proxy',
      modelId: 'qwen2.5-coder:7b',
      apiKey: '',
    })
    expect(view.apiKeySet).toBe(false)
    expect(view.apiKeyKind).toBe('none')
  })

  it('保留其他 provider 与 settings 里无关的字段', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const modelsPath = join(dir, 'models.json')
    const settingsPath = join(dir, 'settings.json')

    // 模拟 Pi 自己写进去的另一份配置
    const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
      providers: Record<string, unknown>
    }
    models.providers['anthropic'] = { baseUrl: 'https://proxy.example.com' }
    writeFileSync(modelsPath, JSON.stringify(models), 'utf8')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    settings['theme'] = 'dark'
    writeFileSync(settingsPath, JSON.stringify(settings), 'utf8')

    writeModelConfig(dir, { providerId: 'local-proxy', modelId: 'qwen2.5-coder:7b' })

    const nextModels = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
      providers: Record<string, unknown>
    }
    expect(nextModels.providers['anthropic']).toBeDefined()
    const nextSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(nextSettings['theme']).toBe('dark')
  })

  it('contextWindow 传 null 会从模型条目里移除', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const view = writeModelConfig(dir, {
      providerId: 'local-proxy',
      modelId: 'qwen2.5-coder:7b',
      contextWindow: null,
    })
    expect(view.contextWindow).toBeUndefined()
  })

  it('thinkingLevel 传 null 会移除默认值', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const view = writeModelConfig(dir, {
      providerId: 'local-proxy',
      modelId: 'qwen2.5-coder:7b',
      thinkingLevel: null,
    })
    expect(view.thinkingLevel).toBeUndefined()
  })

  it('两个文件都以 0600 落盘', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    for (const name of ['models.json', 'settings.json']) {
      const mode = statSync(join(dir, name)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('拒绝非法 providerId / baseUrl / modelId', () => {
    const dir = tempDir()
    expect(() => writeModelConfig(dir, { providerId: 'Bad Id', modelId: 'm1' })).toThrow(HubError)
    expect(() => writeModelConfig(dir, { providerId: 'ok', modelId: 'has space' })).toThrow(
      HubError,
    )
    expect(() =>
      writeModelConfig(dir, { providerId: 'ok', modelId: 'm1', baseUrl: 'ftp://example.com' }),
    ).toThrow(HubError)
    expect(() =>
      writeModelConfig(dir, { providerId: 'ok', modelId: 'm1', baseUrl: 'not a url' }),
    ).toThrow(HubError)
  })

  it('损坏的 models.json 报错而不是被覆盖', () => {
    const dir = tempDir()
    writeModelConfig(dir, basePatch)
    const modelsPath = join(dir, 'models.json')
    writeFileSync(modelsPath, '{ "providers": ', 'utf8')
    expect(() =>
      writeModelConfig(dir, { providerId: 'local-proxy', modelId: 'qwen2.5-coder:7b' }),
    ).toThrow(HubError)
    // 没有被我们的写入覆盖掉：仍然是那段坏内容
    expect(readFileSync(modelsPath, 'utf8')).toBe('{ "providers": ')
  })
})

describe('parseModelPatch', () => {
  it('收窄合法请求体', () => {
    expect(parseModelPatch({ providerId: 'p', modelId: 'm', contextWindow: 1000 })).toEqual({
      providerId: 'p',
      modelId: 'm',
      contextWindow: 1000,
    })
  })

  it('拒绝非对象与缺失字段', () => {
    expect(() => parseModelPatch(null)).toThrow(HubError)
    expect(() => parseModelPatch([])).toThrow(HubError)
    expect(() => parseModelPatch({ providerId: 'p' })).toThrow(HubError)
    expect(() => parseModelPatch({ providerId: 'p', modelId: 'm', contextWindow: 1.5 })).toThrow(
      HubError,
    )
  })

  it('允许 null 表示清除可选字段', () => {
    expect(
      parseModelPatch({ providerId: 'p', modelId: 'm', maxTokens: null, thinkingLevel: null }),
    ).toEqual({ providerId: 'p', modelId: 'm', maxTokens: null, thinkingLevel: null })
  })
})
