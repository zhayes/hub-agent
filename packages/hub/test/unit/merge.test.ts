import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addWorktree,
  type GitResult,
  type GitRunner,
  mergeNoFf,
  removeWorktree,
  resetHard,
  revParse,
} from '../../src/runtime/workspace/git'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

class ShellGitRunner implements GitRunner {
  async run(args: readonly string[], cwd: string): Promise<GitResult> {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
    return {
      ok: result.status === 0,
      code: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-merge-'))
  dirs.push(dir)
  return dir
}

function repo(): { root: string; runner: GitRunner } {
  const root = tempDir()
  const runner = new ShellGitRunner()
  spawnSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'base.txt'), 'base\n')
  spawnSync('git', ['add', 'base.txt'], { cwd: root })
  spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'],
    { cwd: root },
  )
  return { root, runner }
}

async function commitFile(
  runner: GitRunner,
  worktree: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(worktree, file), content)
  await runner.run(['add', file], worktree)
  const result = await runner.run(
    ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', message],
    worktree,
  )
  expect(result.ok).toBe(true)
}

describe('merge：不同 worktree 并行修改后按确定性规则合并', () => {
  it('两个分支改不同文件 -> 都合并成功', async () => {
    const { root, runner } = repo()
    const wtA = join(tempDir(), 'a')
    const wtB = join(tempDir(), 'b')

    await addWorktree(runner, { repoRoot: root, path: wtA, branch: 'feat-a', baseRef: 'HEAD' })
    await addWorktree(runner, { repoRoot: root, path: wtB, branch: 'feat-b', baseRef: 'HEAD' })
    await commitFile(runner, wtA, 'a.txt', 'a\n', 'add a')
    await commitFile(runner, wtB, 'b.txt', 'b\n', 'add b')

    await mergeNoFf(runner, root, 'feat-a')
    await mergeNoFf(runner, root, 'feat-b')

    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b\n')
    expect(await revParse(runner, root, 'HEAD')).toBeTruthy()

    await removeWorktree(runner, root, wtA)
    await removeWorktree(runner, root, wtB)
    expect(existsSync(wtA)).toBe(false)
  })

  it('两个分支改同一文件 -> 冲突升级 DELIVERY_CONFLICT', async () => {
    const { root, runner } = repo()
    const wtA = join(tempDir(), 'a')
    const wtB = join(tempDir(), 'b')

    await addWorktree(runner, { repoRoot: root, path: wtA, branch: 'conflict-a', baseRef: 'HEAD' })
    await addWorktree(runner, { repoRoot: root, path: wtB, branch: 'conflict-b', baseRef: 'HEAD' })
    await commitFile(runner, wtA, 'base.txt', 'from-a\n', 'a')
    await commitFile(runner, wtB, 'base.txt', 'from-b\n', 'b')

    await mergeNoFf(runner, root, 'conflict-a')
    await expect(mergeNoFf(runner, root, 'conflict-b')).rejects.toMatchObject({
      code: 'DELIVERY_CONFLICT',
    })

    await resetHard(runner, root, 'HEAD')
    expect(readFileSync(join(root, 'base.txt'), 'utf8')).toBe('from-a\n')
  })
})
