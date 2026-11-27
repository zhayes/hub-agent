import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/agent-host/agent-host'
import { applyAndVerify, verificationSpecOf } from '../../src/runtime/remote-verify'
import type { SandboxDescription, SandboxProvider } from '../../src/sandbox/types'

const dirs: string[] = []
const hosts: AgentHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) {
    void host.dispose()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 真实 git 仓库（提交一次 README）。 */
function repo(): string {
  const dir = temp('hubagent-remote-verify-')
  const git = (args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', 'README.md'])
  git(['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'])
  return dir
}

/** 在仓库里改一处、取回 diff，然后还原；得到的 patch 可被 `git apply` 干净应用。 */
function makePatch(dir: string): string {
  writeFileSync(join(dir, 'README.md'), '# repo\n\nchanged by remote\n')
  const patch = execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' })
  execFileSync('git', ['checkout', '--', '.'], { cwd: dir })
  return patch
}

function provider(): SandboxProvider {
  return {
    describe: (): SandboxDescription => ({
      kind: 'srt',
      platform: process.platform,
      ready: true,
      detail: 'test',
    }),
    async wrap(command: string) {
      return { argv: ['/bin/bash', '-c', command], env: process.env }
    },
    async dispose() {},
  } as unknown as SandboxProvider
}

function host(): AgentHost {
  const created = new AgentHost({ provider: provider() })
  hosts.push(created)
  return created
}

const passCheck = {
  kind: 'command' as const,
  cmd: 'grep -q changed README.md',
  timeoutMs: 20_000,
  expect: { exitCode: 0 },
}

const failCheck = {
  kind: 'command' as const,
  cmd: 'grep -q definitely-not-there README.md',
  timeoutMs: 20_000,
  expect: { exitCode: 0 },
}

describe('远端交付物：本地应用与验收（PRD §7.7）', () => {
  it('patch 干净应用 + 检查通过 → pass', async () => {
    const dir = repo()
    const patch = makePatch(dir)

    const result = await applyAndVerify({
      host: host(),
      executionId: 'exec-1',
      spec: { worktree: dir, checks: [passCheck] },
      patch: { content: patch },
      artifactDir: temp('hubagent-remote-artifacts-'),
    })

    expect(result.patch).toBe('applied')
    expect(result.verdict).toBe('pass')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('changed by remote')
  })

  it('应用后检查不通过 → fail（应用本身不等于成功）', async () => {
    const dir = repo()
    const patch = makePatch(dir)

    const result = await applyAndVerify({
      host: host(),
      executionId: 'exec-2',
      spec: { worktree: dir, checks: [failCheck] },
      patch: { content: patch },
      artifactDir: temp('hubagent-remote-artifacts-'),
    })

    expect(result.patch).toBe('applied')
    expect(result.verdict).toBe('fail')
  })

  it('重复应用是幂等的：第二次识别为 already-applied 而不是冲突', async () => {
    const dir = repo()
    const patch = makePatch(dir)
    const artifactDir = temp('hubagent-remote-artifacts-')
    const runner = host()

    const first = await applyAndVerify({
      host: runner,
      executionId: 'exec-3',
      spec: { worktree: dir, checks: [passCheck] },
      patch: { content: patch },
      artifactDir,
    })
    expect(first.patch).toBe('applied')

    const second = await applyAndVerify({
      host: runner,
      executionId: 'exec-3',
      spec: { worktree: dir, checks: [passCheck] },
      patch: { content: patch },
      artifactDir,
    })
    expect(second.patch).toBe('already-applied')
    expect(second.verdict).toBe('pass')
  })

  it('基线不一致、patch 无法干净应用 → rejected + fail，绝不冒充成功', async () => {
    const dir = repo()
    const patch = makePatch(dir)
    /* 让本地基线偏离：patch 的上下文对不上了。 */
    writeFileSync(join(dir, 'README.md'), '# totally different\n')
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qam', 'diverge'],
      {
        cwd: dir,
      },
    )

    const result = await applyAndVerify({
      host: host(),
      executionId: 'exec-4',
      spec: { worktree: dir, checks: [passCheck] },
      patch: { content: patch },
      artifactDir: temp('hubagent-remote-artifacts-'),
    })

    expect(result.patch).toBe('rejected')
    expect(result.verdict).toBe('fail')
    expect(result.detail).toContain('无法在本地基线干净应用')
  })

  it('没有 patch 也没有检查 → manual_required（无法自动判定）', async () => {
    const dir = repo()

    const result = await applyAndVerify({
      host: host(),
      executionId: 'exec-5',
      spec: { worktree: dir },
      artifactDir: temp('hubagent-remote-artifacts-'),
    })

    expect(result.patch).toBe('none')
    expect(result.verdict).toBe('manual_required')
  })
})

describe('验收规格从派发 payload 读取', () => {
  it('解析 worktree / checks / 网络策略', () => {
    const spec = verificationSpecOf({
      peerId: 'peer-b',
      verification: {
        worktree: '/tmp/wt',
        checks: [passCheck],
        networkMode: 'allowlist',
        allowedDomains: ['example.com'],
        allowedWrite: ['/tmp/wt'],
      },
    })
    expect(spec?.worktree).toBe('/tmp/wt')
    expect(spec?.checks).toHaveLength(1)
    expect(spec?.networkMode).toBe('allowlist')
    expect(spec?.allowedDomains).toEqual(['example.com'])
  })

  it('缺 worktree 或结构不对 → undefined（转人工验收）', () => {
    expect(verificationSpecOf({ peerId: 'x' })).toBeUndefined()
    expect(verificationSpecOf({ verification: {} })).toBeUndefined()
    expect(verificationSpecOf(null)).toBeUndefined()
    expect(verificationSpecOf('nope')).toBeUndefined()
  })
})
