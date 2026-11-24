import { describe, expect, it } from 'vitest'
import { evaluateSrtPlatform, probeSrtPlatform } from '../../src/sandbox/srt-driver'

const windowsOk = {
  userProvisioned: true,
  groupExists: true,
  wfpState: 'installed',
} as const

describe('srt 平台自检：Windows', () => {
  it('未 provision 时给出 SANDBOX_NOT_PROVISIONED 与安装命令', () => {
    const result = evaluateSrtPlatform({
      platform: 'win32',
      windows: { userProvisioned: false, groupExists: false, wfpState: 'absent' },
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('SANDBOX_NOT_PROVISIONED')
    expect(result.detail).toContain('windows-install')
    expect(result.detail).toContain('WFP')
  })

  it('WFP loopback 模式不一致也阻塞', () => {
    const result = evaluateSrtPlatform({
      platform: 'win32',
      windows: { ...windowsOk, wfpState: 'loopback-mismatch' },
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('loopback')
  })

  it('持久写授权未释放时阻塞', () => {
    const result = evaluateSrtPlatform({
      platform: 'win32',
      windows: { ...windowsOk, persistentGrants: 'present' },
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('acl forget')
  })

  it('cannot-read 只是非提权，不阻塞', () => {
    const result = evaluateSrtPlatform({
      platform: 'win32',
      windows: { ...windowsOk, wfpState: 'cannot-read' },
    })
    expect(result.ok).toBe(true)
  })

  it('状态读不到时 fail-closed', () => {
    const result = evaluateSrtPlatform({ platform: 'win32' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('SANDBOX_NOT_PROVISIONED')
  })
})

describe('srt 平台自检：Linux', () => {
  it('apparmor userns 被限制时给出可执行修复命令', () => {
    const result = evaluateSrtPlatform({ platform: 'linux', apparmorUserns: '1\n' })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('apparmor_restrict_unprivileged_userns')
    expect(result.detail).toContain('sysctl')
  })

  it('已关闭或没有该内核项时通过', () => {
    expect(evaluateSrtPlatform({ platform: 'linux', apparmorUserns: '0\n' }).ok).toBe(true)
    expect(evaluateSrtPlatform({ platform: 'linux' }).ok).toBe(true)
  })
})

describe('srt 平台自检：其他平台', () => {
  it('macOS 不需要额外平台检查', () => {
    const result = evaluateSrtPlatform({ platform: 'darwin' })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('sandbox-exec')
  })

  it('未知平台 fail-closed', () => {
    const result = evaluateSrtPlatform({ platform: 'freebsd' })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('freebsd')
  })

  it('probeSrtPlatform 在当前 macOS 上可用', async () => {
    if (process.platform !== 'darwin') return
    const result = await probeSrtPlatform('darwin')
    expect(result.ok).toBe(true)
  })
})
