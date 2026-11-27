import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildChooseFolderArgs,
  type ExecResult,
  isCancellation,
  parseChooseFolderOutput,
  pickDirectory,
  resetPickerState,
} from '../../src/agent-host/native-picker'

const dirs: string[] = []

afterEach(() => {
  resetPickerState()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-picker-'))
  dirs.push(dir)
  return dir
}

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' }
}

describe('AppleScript 参数', () => {
  it('构造 choose folder 脚本并转义引号与反斜杠', () => {
    const args = buildChooseFolderArgs('选 "目录" C:\\tmp')
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('choose folder with prompt')
    /* 引号必须被转义，否则脚本会被截断。 */
    expect(args[1]).toContain('\\"目录\\"')
    expect(args[1]).toContain('C:\\\\tmp')
  })
})

describe('输出解析', () => {
  it('取绝对路径并去掉末尾斜杠', () => {
    expect(parseChooseFolderOutput('/Users/chad/proj/\n')).toBe('/Users/chad/proj')
    expect(parseChooseFolderOutput('/Users/chad\n')).toBe('/Users/chad')
  })

  it('空输出或相对路径视为未选中', () => {
    expect(parseChooseFolderOutput('   \n')).toBeUndefined()
    expect(parseChooseFolderOutput('relative/path')).toBeUndefined()
  })
})

describe('取消识别', () => {
  it('osascript 的 -128 / User canceled 视为取消', () => {
    expect(
      isCancellation({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }),
    ).toBe(true)
    expect(isCancellation({ code: 0, stdout: '/tmp', stderr: '' })).toBe(false)
  })
})

describe('pickDirectory', () => {
  it('非 macOS 返回 unsupported（前端降级为手填）', async () => {
    const outcome = await pickDirectory({ platform: 'linux' })
    expect(outcome).toEqual({ kind: 'unsupported' })
  })

  it('选中真实目录 → picked', async () => {
    const dir = tempDir()
    const outcome = await pickDirectory({
      platform: 'darwin',
      exec: async () => ok(`${dir}\n`),
    })
    expect(outcome).toEqual({ kind: 'picked', path: dir })
  })

  it('用户取消 → cancelled', async () => {
    const outcome = await pickDirectory({
      platform: 'darwin',
      exec: async () => ({ code: 1, stdout: '', stderr: 'User canceled. (-128)' }),
    })
    expect(outcome).toEqual({ kind: 'cancelled' })
  })

  it('选中的不是目录（或已消失）→ cancelled，不把坏路径交给上层', async () => {
    const dir = tempDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x', 'utf8')

    expect(await pickDirectory({ platform: 'darwin', exec: async () => ok(`${file}\n`) })).toEqual({
      kind: 'cancelled',
    })

    expect(
      await pickDirectory({ platform: 'darwin', exec: async () => ok('/nonexistent/xyz\n') }),
    ).toEqual({ kind: 'cancelled' })
  })

  it('同一时刻只允许一个弹框：并发调用返回 busy', async () => {
    let release: ((result: ExecResult) => void) | undefined
    const pending = new Promise<ExecResult>((resolve) => {
      release = resolve
    })

    const first = pickDirectory({ platform: 'darwin', exec: () => pending })
    const second = await pickDirectory({
      platform: 'darwin',
      exec: async () => ok(tempDir()),
    })
    expect(second).toEqual({ kind: 'busy' })

    release?.(ok(tempDir()))
    expect((await first).kind).toBe('picked')
  })
})
