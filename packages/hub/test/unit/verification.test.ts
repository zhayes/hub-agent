import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function tempDir(prefix = 'hubagent-verify-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

class ShellProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

function host(): AgentHost {
  const value = new AgentHost({ provider: new ShellProvider() })
  hosts.push(value)
  return value
}

describe('Verification Runner：command / fileExists', () => {
  it('command 退出码符合预期 -> pass，并落日志引用', async () => {
    const worktree = tempDir()
    const artifactDir = join(worktree, '.artifacts')
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'command', cmd: 'printf ok', timeoutMs: 5_000, expect: { exitCode: 0 } }],
      artifactDir,
      host: host(),
    })

    expect(outcome.run.verdict).toBe('pass')
    expect(outcome.run.checks[0]?.passed).toBe(true)
    expect(outcome.run.checks[0]?.exitCode).toBe(0)
    const log = outcome.run.checks[0]?.outputRef
    expect(log).toBeTruthy()
    expect(readFileSync(log ?? '', 'utf8')).toContain('stdout')
  })

  it('command 退出码不符 -> fail，保留实际 exitCode', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'command', cmd: 'exit 3', timeoutMs: 5_000, expect: { exitCode: 0 } }],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })

    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.run.checks[0]?.passed).toBe(false)
    expect(outcome.run.checks[0]?.exitCode).toBe(3)
  })

  it('expect.exitCode 支持数组', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'command', cmd: 'exit 3', timeoutMs: 5_000, expect: { exitCode: [0, 3] } }],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('pass')
  })

  it('fileExists 命中/缺失', async () => {
    const worktree = tempDir()
    writeFileSync(join(worktree, 'dist.js'), 'x')
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [
        { kind: 'fileExists', path: 'dist.js' },
        { kind: 'fileExists', path: 'missing.js' },
      ],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.run.checks[0]?.passed).toBe(true)
    expect(outcome.run.checks[1]?.passed).toBe(false)
  })

  it('fileExists 拒绝 worktree 之外的路径', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'fileExists', path: '../outside.txt' }],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.checks[0]?.passed).toBe(false)
  })
})

describe('Verification Runner：diffScope / noUnexpectedChange（TC-008）', () => {
  it('越界修改 -> diffScope fail', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
      changedFiles: ['src/a.ts', '.github/workflows/ci.yml'],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })

    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.run.checks[0]?.passed).toBe(false)
    const log = readFileSync(outcome.run.checks[0]?.outputRef ?? '', 'utf8')
    expect(log).toContain('.github/workflows/ci.yml')
  })

  it('全部落在 allowedPaths 内 -> pass', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
      changedFiles: ['src/a.ts', '.github/workflows/ci.yml'],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('pass')
  })

  it('关键文件被改动 -> noUnexpectedChange fail', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'noUnexpectedChange', paths: ['package-lock.json'] }],
      changedFiles: ['package-lock.json'],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.run.checks[0]?.passed).toBe(false)
  })
})

describe('Verification Runner：自证与人工复核', () => {
  it('llmReview -> manual_required，绝不自动 pass', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [{ kind: 'llmReview', rubric: 'review', evidenceRefs: [] }],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('manual_required')
    expect(outcome.run.checks[0]?.passed).toBe(false)
    expect(outcome.run.checks[0]?.manualRequired).toBe(true)
  })

  it('没有检查 -> manual_required，不默认通过', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('manual_required')
  })

  it('识别 sandbox_denied 信号', async () => {
    const worktree = tempDir()
    const outcome = await runVerification({
      executionId: 'e1',
      worktree,
      checks: [
        {
          kind: 'command',
          cmd: "printf 'Operation not permitted' >&2; exit 1",
          timeoutMs: 5_000,
          expect: { exitCode: 0 },
        },
      ],
      artifactDir: join(worktree, '.artifacts'),
      host: host(),
    })
    expect(outcome.run.verdict).toBe('fail')
    expect(outcome.sandboxDenied?.source).toContain('Operation not permitted')
  })
})
