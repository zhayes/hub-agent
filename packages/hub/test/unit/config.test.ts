import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/shared/config'
import { HubError } from '../../src/shared/errors'

async function tempConfig(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hubagent-config-'))
  const path = join(dir, 'config.toml')
  if (content !== undefined) await writeFile(path, content, 'utf8')
  return path
}

describe('config defaults', () => {
  it('默认值：只监听回环端口，日志 info', async () => {
    const loaded = await loadConfig(await tempConfig())
    expect(loaded.config.server.port).toBe(7788)
    expect(loaded.config.logging.level).toBe('info')
  })

  it('缺文件不是错误，返回默认值', async () => {
    const loaded = await loadConfig(await tempConfig())
    expect(loaded.found).toBe(false)
  })

  it('不再提供“跳过沙箱”开关（ADR 0002 决策 1）', async () => {
    // 旧的 security.requireSandbox / sandbox.provider 会被静默忽略，
    // 不会产生任何“关闭隔离”的效果。
    const loaded = await loadConfig(
      await tempConfig('[security]\nrequireSandbox = false\n\n[sandbox]\nprovider = "none"\n'),
    )
    expect(Object.keys(loaded.config)).not.toContain('security')
    expect(Object.keys(loaded.config)).not.toContain('sandbox')
  })
})

describe('config loading', () => {
  it('解析合法 TOML 并补全默认值', async () => {
    const path = await tempConfig('[server]\nport = 9000\n')
    const loaded = await loadConfig(path)
    expect(loaded.found).toBe(true)
    expect(loaded.config.server.port).toBe(9000)
    expect(loaded.config.logging.level).toBe('info')
  })

  it('TOML 语法错误 → CONFIG_INVALID', async () => {
    const path = await tempConfig('x = ')
    await expect(loadConfig(path)).rejects.toBeInstanceOf(HubError)
    await expect(loadConfig(path)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('schema 校验失败 → CONFIG_INVALID，并指出字段', async () => {
    const path = await tempConfig('[server]\nport = 0\n')
    await expect(loadConfig(path)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('server.port'),
    })
  })
})
