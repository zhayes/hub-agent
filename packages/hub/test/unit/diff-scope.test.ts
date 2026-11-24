import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../../src/agent-host/agent-host'
import { runVerification } from '../../src/runtime/verify/runner'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'

const dirs: string[] = []
const hosts: AgentHost[] = []

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.dispose()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

class ShellProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

describe('diffScope（TC-008）', () => {
  it('改动 CI 配置超出 allowedPaths -> fail，并留下违规日志', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'hubagent-diff-scope-'))
    dirs.push(worktree)
    const host = new AgentHost({ provider: new ShellProvider() })
    hosts.push(host)

    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
      changedFiles: ['src/auth.ts', '.github/workflows/ci.yml', 'package-lock.json'],
      artifactDir: join(worktree, '.artifacts'),
      host,
    })

    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.run.checks[0]?.kind).toBe('diffScope')
    expect(outcome.run.checks[0]?.passed).toBe(false)
    const log = readFileSync(outcome.run.checks[0]?.outputRef ?? '', 'utf8')
    expect(log).toContain('.github/workflows/ci.yml')
    expect(log).toContain('package-lock.json')
  })

  it('允许路径覆盖全部改动 -> pass', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'hubagent-diff-scope-'))
    dirs.push(worktree)
    const host = new AgentHost({ provider: new ShellProvider() })
    hosts.push(host)

    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
      changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
      artifactDir: join(worktree, '.artifacts'),
      host,
    })
    expect(outcome.run.verdict).toBe('pass')
  })
})
