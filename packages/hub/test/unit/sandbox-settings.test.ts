import { describe, expect, it } from 'vitest'
import {
  buildSrtSessionSettings,
  buildSrtSettings,
  DEFAULT_DENY_READ,
  DEFAULT_DENY_WRITE,
} from '../../src/sandbox/settings'
import { assertSandboxSpec, type SandboxSpec } from '../../src/sandbox/types'

const CWD = '/work/project'

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return { cwd: CWD, allowedWrite: [], ...overrides }
}

describe('SandboxSpec 静态校验', () => {
  it('cwd 必须是绝对路径', () => {
    expect(() => assertSandboxSpec(spec({ cwd: 'relative/dir' }))).toThrowError(/绝对路径/)
  })

  it('allowedWrite 必须是绝对路径', () => {
    expect(() => assertSandboxSpec(spec({ allowedWrite: ['src'] }))).toThrowError(/绝对路径/)
  })

  it('timeoutMs 必须为正数', () => {
    expect(() => assertSandboxSpec(spec({ timeoutMs: 0 }))).toThrowError(/正数/)
  })

  it('合法 spec 不抛错', () => {
    expect(() => assertSandboxSpec(spec({ allowedWrite: ['/work/project/src'] }))).not.toThrow()
  })

  it('未知 networkMode 被拒', () => {
    expect(() =>
      assertSandboxSpec(spec({ networkMode: 'bogus' as unknown as SandboxSpec['networkMode'] })),
    ).toThrowError(/networkMode/)
  })
})

describe('srt settings：读默认放行 + 显式 deny', () => {
  it('默认拒绝凭据目录', () => {
    const settings = buildSrtSettings(spec())
    for (const dir of DEFAULT_DENY_READ) {
      expect(settings.filesystem.denyRead).toContain(dir)
    }
    expect(settings.filesystem.denyRead).toContain('~/.ssh')
    expect(settings.filesystem.denyRead).toContain('~/.aws')
    expect(settings.filesystem.denyRead).toContain('~/.kube')
  })

  it('额外的 denyRead 会合并去重', () => {
    const settings = buildSrtSettings(spec({ denyRead: ['/work/project/secrets', '~/.ssh'] }))
    expect(settings.filesystem.denyRead).toContain('/work/project/secrets')
    expect(settings.filesystem.denyRead.filter((p) => p === '~/.ssh')).toHaveLength(1)
  })
})

describe('srt settings：写默认拒绝 + 显式 allow', () => {
  it('cwd 自动进入 allowWrite', () => {
    const settings = buildSrtSettings(spec())
    expect(settings.filesystem.allowWrite).toContain(CWD)
  })

  it('只放行给定的写入路径，不多给', () => {
    const settings = buildSrtSettings(spec({ allowedWrite: [`${CWD}/src`] }))
    expect(settings.filesystem.allowWrite).toEqual([CWD, `${CWD}/src`])
  })

  it('重复的写入路径去重', () => {
    const settings = buildSrtSettings(spec({ allowedWrite: [CWD, CWD] }))
    expect(settings.filesystem.allowWrite).toEqual([CWD])
  })

  it('默认拒绝改写 .env', () => {
    const settings = buildSrtSettings(spec())
    for (const path of DEFAULT_DENY_WRITE) {
      expect(settings.filesystem.denyWrite).toContain(path)
    }
  })
})

describe('srt settings：网络默认 agent-managed', () => {
  it('默认不设置 allowedDomains（不安装网络代理）', () => {
    const settings = buildSrtSettings(spec())
    expect(settings.network).not.toHaveProperty('allowedDomains')
    expect(settings.network.deniedDomains).toEqual([])
  })

  it('显式 allowlist 的域名被保留且去重', () => {
    const settings = buildSrtSettings(
      spec({
        networkMode: 'allowlist',
        allowedDomains: ['registry.npmjs.org', 'registry.npmjs.org', 'github.com'],
      }),
    )
    expect(settings.network.allowedDomains).toEqual(['registry.npmjs.org', 'github.com'])
  })

  it('deny 模式允许列表为空（代理拒绝全部出网）', () => {
    const settings = buildSrtSettings(spec({ networkMode: 'deny' }))
    expect(settings.network.allowedDomains).toEqual([])
  })

  it('agent-managed 不能同时声明域名白名单', () => {
    expect(() =>
      assertSandboxSpec(spec({ networkMode: 'agent-managed', allowedDomains: ['example.com'] })),
    ).toThrowError(/agent-managed/)
  })

  it('allowLocalBinding 只在显式开启时出现', () => {
    expect(buildSrtSettings(spec()).network).not.toHaveProperty('allowLocalBinding')
    expect(buildSrtSettings(spec({ allowLocalBinding: true })).network.allowLocalBinding).toBe(true)
  })
})

describe('srt 会话基线：不把任务级权限放进全局配置', () => {
  it('默认 agent-managed：不授予写权限，也不安装网络代理', () => {
    const settings = buildSrtSessionSettings()
    expect(settings.filesystem.allowWrite).toEqual([])
    expect(settings.network).not.toHaveProperty('allowedDomains')
    expect(settings.filesystem.denyRead).toEqual(DEFAULT_DENY_READ)
    expect(settings.filesystem.denyWrite).toEqual(DEFAULT_DENY_WRITE)
  })

  it('allowlist 会话：域名基线为空，deniedDomains 去重', () => {
    const settings = buildSrtSessionSettings({
      networkMode: 'allowlist',
      deniedDomains: ['evil.example', 'evil.example', 'other.example'],
    })
    expect(settings.network.allowedDomains).toEqual([])
    expect(settings.network.deniedDomains).toEqual(['evil.example', 'other.example'])
    expect(settings.network).not.toHaveProperty('allowLocalBinding')

    expect(
      buildSrtSessionSettings({ networkMode: 'allowlist', allowLocalBinding: true }).network
        .allowLocalBinding,
    ).toBe(true)
  })
})
