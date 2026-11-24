import { describe, expect, it } from 'vitest'
import type { SrtSettings } from '../../src/sandbox/settings'
import {
  type SrtDependencyReport,
  type SrtDriver,
  SrtProvider,
  type SrtWindowsStatus,
  type SrtWrapOptions,
  WINDOWS_INSTALL_COMMAND,
} from '../../src/sandbox/srt-provider'
import type { SandboxSpec } from '../../src/sandbox/types'

const CWD = '/work/project'

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return { cwd: CWD, allowedWrite: [], ...overrides }
}

interface WrapCall {
  command: string
  settings: SrtSettings
  cwd: string
  options: SrtWrapOptions | undefined
}

class FakeDriver implements SrtDriver {
  supported = true
  deps: SrtDependencyReport = { errors: [], warnings: [] }
  windows: SrtWindowsStatus = {
    userProvisioned: true,
    groupExists: true,
    wfpState: 'installed',
  }
  readonly initialized: SrtSettings[] = []
  readonly wrapCalls: WrapCall[] = []
  readonly registered = new Map<string, string[]>()
  readonly unregistered: string[] = []
  resetCalls = 0
  initError: Error | undefined
  wrapError: Error | undefined
  registerError: Error | undefined
  result: { argv: string[]; env: NodeJS.ProcessEnv } = {
    argv: ['/bin/bash', '-c', 'wrapped'],
    env: { PATH: '/usr/bin' },
  }

  isSupportedPlatform(): boolean {
    return this.supported
  }

  checkDependencies(): SrtDependencyReport {
    return this.deps
  }

  checkWindowsStatus(): SrtWindowsStatus {
    return this.windows
  }

  async initialize(settings: SrtSettings): Promise<void> {
    if (this.initError !== undefined) throw this.initError
    this.initialized.push(settings)
  }

  async wrapArgv(
    command: string,
    settings: SrtSettings,
    cwd: string,
    options?: SrtWrapOptions,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
    if (this.wrapError !== undefined) throw this.wrapError
    this.wrapCalls.push({ command, settings, cwd, options })
    return this.result
  }

  registerCommandNetworkLists(commandId: string, lists: { allowedDomains: string[] }): void {
    if (this.registerError !== undefined) throw this.registerError
    this.registered.set(commandId, lists.allowedDomains)
  }

  unregisterCommandNetworkLists(commandId: string): void {
    this.unregistered.push(commandId)
    this.registered.delete(commandId)
  }

  async reset(): Promise<void> {
    this.resetCalls += 1
  }
}

describe('SrtProvider：就绪判定', () => {
  it('依赖正常时 describe ready', () => {
    const provider = new SrtProvider(new FakeDriver(), 'darwin')
    expect(provider.describe()).toMatchObject({
      kind: 'srt',
      platform: 'darwin',
      ready: true,
    })
  })

  it('依赖错误时不 ready，wrap 抛 SANDBOX_UNAVAILABLE 且不初始化', async () => {
    const driver = new FakeDriver()
    driver.deps = { errors: ['ripgrep (rg) not found'], warnings: [] }
    const provider = new SrtProvider(driver, 'darwin')

    const description = provider.describe()
    expect(description.ready).toBe(false)
    expect(description.detail).toContain('ripgrep')

    await expect(provider.wrap('echo hi', spec())).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(driver.initialized).toHaveLength(0)
  })

  it('平台不支持时 fail-closed', async () => {
    const driver = new FakeDriver()
    driver.supported = false
    const provider = new SrtProvider(driver, 'darwin')

    expect(provider.describe().ready).toBe(false)
    await expect(provider.wrap('echo hi', spec())).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })

  it('warnings 不影响 ready，但会出现在 detail', () => {
    const driver = new FakeDriver()
    driver.deps = { errors: [], warnings: ['bubblewrap 版本偏旧'] }
    const provider = new SrtProvider(driver, 'linux')
    const description = provider.describe()
    expect(description.ready).toBe(true)
    expect(description.detail).toContain('bubblewrap 版本偏旧')
  })
})

describe('SrtProvider：Windows 未安装', () => {
  it('未 provision 时 SANDBOX_NOT_PROVISIONED，并给出安装命令', async () => {
    const driver = new FakeDriver()
    driver.windows = { userProvisioned: false, groupExists: false, wfpState: 'absent' }
    const provider = new SrtProvider(driver, 'win32')

    expect(provider.describe().ready).toBe(false)
    expect(provider.describe().detail).toContain(WINDOWS_INSTALL_COMMAND)

    let caught: unknown
    try {
      await provider.wrap('echo hi', spec())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'SANDBOX_NOT_PROVISIONED',
      details: { install: WINDOWS_INSTALL_COMMAND, platform: 'win32' },
    })
    expect(driver.initialized).toHaveLength(0)
  })

  it('loopback 模式不一致与持久写授权都视为未就绪', () => {
    const driver = new FakeDriver()
    driver.windows = {
      userProvisioned: true,
      groupExists: true,
      wfpState: 'loopback-mismatch',
      persistentGrants: 'present',
    }
    const description = new SrtProvider(driver, 'win32').describe()
    expect(description.ready).toBe(false)
    expect(description.detail).toContain('loopback')
    expect(description.detail).toContain('acl forget')
  })

  it('cannot-read 只是非提权，不阻塞', () => {
    const driver = new FakeDriver()
    driver.windows = { userProvisioned: true, groupExists: true, wfpState: 'cannot-read' }
    expect(new SrtProvider(driver, 'win32').describe().ready).toBe(true)
  })
})

describe('SrtProvider：会话初始化', () => {
  it('只初始化一次，基线不授予写权限、不放行域名', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await provider.wrap('echo a', spec())
    await provider.wrap('echo b', spec())

    expect(driver.initialized).toHaveLength(1)
    const session = driver.initialized[0]
    expect(session?.network.allowedDomains).toEqual([])
    expect(session?.filesystem.allowWrite).toEqual([])
    expect(session?.filesystem.denyRead).toContain('~/.ssh')
    expect(driver.wrapCalls).toHaveLength(2)
  })

  it('初始化失败后不缓存失败，下一次可以重试', async () => {
    const driver = new FakeDriver()
    driver.initError = new Error('proxy failed')
    const provider = new SrtProvider(driver, 'darwin')

    await expect(provider.wrap('echo a', spec())).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(driver.initialized).toHaveLength(0)

    driver.initError = undefined
    await provider.wrap('echo b', spec())
    expect(driver.initialized).toHaveLength(1)
  })

  it('会话级策略变化时拒绝执行（不静默放宽）', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await provider.wrap('echo a', spec({ allowLocalBinding: false }))
    await expect(provider.wrap('echo b', spec({ allowLocalBinding: true }))).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(driver.wrapCalls).toHaveLength(1)
  })

  it('deniedDomains 变化同样被拒', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await provider.wrap('echo a', spec({ deniedDomains: ['evil.example'] }))
    await expect(
      provider.wrap('echo b', spec({ deniedDomains: ['other.example'] })),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })
})

describe('SrtProvider：per-command 策略', () => {
  it('worktree 进入 allowWrite，cwd 原样传给 srt', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await provider.wrap('echo hi', spec({ allowedWrite: [`${CWD}/src`] }))

    const call = driver.wrapCalls[0]
    expect(call?.cwd).toBe(CWD)
    expect(call?.settings.filesystem.allowWrite).toEqual([CWD, `${CWD}/src`])
    expect(call?.settings.network.deniedDomains).toEqual([])
  })

  it('域名白名单注册到随机 commandId，release 幂等', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    const result = await provider.wrap(
      'npm install',
      spec({ allowedDomains: ['registry.npmjs.org', 'github.com'] }),
    )

    const call = driver.wrapCalls[0]
    const key = call?.options?.commandId
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(driver.registered.get(key ?? '')).toEqual(['registry.npmjs.org', 'github.com'])
    expect(result.commandId).toBe(key)

    provider.release(key ?? '')
    provider.release(key ?? '')
    expect(driver.unregistered).toEqual([key])
    expect(driver.registered.size).toBe(0)
  })

  it('每次命令的网络 key 不同', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await provider.wrap('a', spec({ allowedDomains: ['a.example'] }))
    await provider.wrap('b', spec({ allowedDomains: ['b.example'] }))
    const first = driver.wrapCalls[0]?.options?.commandId
    const second = driver.wrapCalls[1]?.options?.commandId
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })

  it('没有域名时不注册，spec.commandId 直接作为归因键', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    const result = await provider.wrap('echo hi', spec({ commandId: 'exec-1' }))
    expect(driver.registered.size).toBe(0)
    expect(driver.wrapCalls[0]?.options).toEqual({ commandId: 'exec-1' })
    expect(result.commandId).toBeUndefined()
  })

  it('spec.env 叠加在 srt 返回的 env 之上', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')
    driver.result = { argv: ['/bin/bash', '-c', 'x'], env: { PATH: '/usr/bin', HOME: '/home/u' } }

    const result = await provider.wrap('echo hi', spec({ env: { FOO: 'bar', HOME: '/tmp/home' } }))
    expect(result.env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home', FOO: 'bar' })
  })

  it('wrap 失败时释放已注册的网络 key，并收敛为稳定错误码', async () => {
    const driver = new FakeDriver()
    driver.wrapError = new Error('spawn failed')
    const provider = new SrtProvider(driver, 'darwin')

    await expect(
      provider.wrap('npm install', spec({ allowedDomains: ['registry.npmjs.org'] })),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })

    expect(driver.unregistered).toHaveLength(1)
    expect(driver.registered.size).toBe(0)
  })

  it('注册白名单失败时不上抛 srt 原始错误', async () => {
    const driver = new FakeDriver()
    driver.registerError = new Error('invalid domain')
    const provider = new SrtProvider(driver, 'darwin')

    await expect(
      provider.wrap('npm install', spec({ allowedDomains: ['bad domain'] })),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(driver.wrapCalls).toHaveLength(0)
  })
})

describe('SrtProvider：静态约束与释放', () => {
  it('相对 cwd 在任何 I/O 之前被拒', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')

    await expect(provider.wrap('echo hi', spec({ cwd: 'relative' }))).rejects.toThrowError(
      /绝对路径/,
    )
    expect(driver.initialized).toHaveLength(0)
  })

  it('空命令被拒', async () => {
    const provider = new SrtProvider(new FakeDriver(), 'darwin')
    await expect(provider.wrap('   ', spec())).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })

  it('dispose 幂等并清理未 release 的网络 key', async () => {
    const driver = new FakeDriver()
    const provider = new SrtProvider(driver, 'darwin')
    await provider.wrap('npm install', spec({ allowedDomains: ['registry.npmjs.org'] }))

    await provider.dispose()
    await provider.dispose()

    expect(driver.resetCalls).toBe(1)
    expect(driver.unregistered).toHaveLength(1)
    expect(driver.registered.size).toBe(0)
    expect(provider.describe().ready).toBe(false)
    await expect(provider.wrap('echo hi', spec())).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })
})

describe('SrtProvider：Windows 会话级写授权', () => {
  it('首个 spec 的写授权进入 initialize，per-command 只传 deny', async () => {
    const driver = new FakeDriver()
    driver.windows = { userProvisioned: true, groupExists: true, wfpState: 'installed' }
    const provider = new SrtProvider(driver, 'win32')

    await provider.wrap('echo hi', spec({ allowedWrite: [`${CWD}/src`] }))

    expect(driver.initialized[0]?.filesystem.allowWrite).toEqual([CWD, `${CWD}/src`])
    const call = driver.wrapCalls[0]
    expect(call?.settings.filesystem.allowWrite).toEqual([])
    expect(call?.settings.filesystem.allowRead).toEqual([])
    expect(call?.settings.filesystem.denyRead).toContain('~/.ssh')
  })

  it('域名仍走 per-command，不进入 Windows 会话白名单', async () => {
    const driver = new FakeDriver()
    driver.windows = { userProvisioned: true, groupExists: true, wfpState: 'installed' }
    const provider = new SrtProvider(driver, 'win32')

    await provider.wrap('npm install', spec({ allowedDomains: ['registry.npmjs.org'] }))

    expect(driver.initialized[0]?.network.allowedDomains).toEqual([])
    const key = driver.wrapCalls[0]?.options?.commandId
    expect(driver.registered.get(key ?? '')).toEqual(['registry.npmjs.org'])
  })

  it('第二个 worktree 因写授权不同被拒（当前会话已固定）', async () => {
    const driver = new FakeDriver()
    driver.windows = { userProvisioned: true, groupExists: true, wfpState: 'installed' }
    const provider = new SrtProvider(driver, 'win32')

    await provider.wrap('echo a', spec({ cwd: '/work/a' }))
    await expect(provider.wrap('echo b', spec({ cwd: '/work/b' }))).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(driver.wrapCalls).toHaveLength(1)
  })
})
