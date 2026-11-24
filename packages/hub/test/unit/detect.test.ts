import { describe, expect, it } from 'vitest'
import {
  checkNodeVersion,
  evaluateSandboxReadiness,
  probeTool,
  type ToolProbe,
} from '../../src/sandbox/detect'

const ok = (name: string): ToolProbe => ({ name, available: true, version: `${name} 1.0.0` })
const missing = (name: string): ToolProbe => ({ name, available: false })

describe('sandbox readiness', () => {
  it('macOS 只要 srt + rg', () => {
    const result = evaluateSandboxReadiness([ok('srt'), ok('rg')], 'darwin')
    expect(result.required).toEqual(['srt', 'rg'])
    expect(result.ready).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('Linux 额外要求 bwrap 与 socat', () => {
    const result = evaluateSandboxReadiness([ok('srt'), ok('rg')], 'linux')
    expect(result.required).toEqual(['srt', 'bwrap', 'socat', 'rg'])
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual(['bwrap', 'socat'])
    expect(result.note).toContain('fail-closed')
  })

  it('缺任何必需项都不 ready', () => {
    const result = evaluateSandboxReadiness([missing('srt'), ok('rg')], 'darwin')
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual(['srt'])
  })
})

describe('node version gate', () => {
  it('接受等于与更高的版本', () => {
    expect(checkNodeVersion('22.12.0').ok).toBe(true)
    expect(checkNodeVersion('v22.13.1').ok).toBe(true)
    expect(checkNodeVersion('26.12.1').ok).toBe(true)
  })

  it('拒绝更低的版本', () => {
    expect(checkNodeVersion('22.11.9').ok).toBe(false)
    expect(checkNodeVersion('20.19.0').ok).toBe(false)
  })

  it('detail 里写清需求', () => {
    expect(checkNodeVersion('20.1.0').detail).toContain('22.12.0')
  })
})

describe('probeTool', () => {
  it('不存在的命令返回 available=false，而不是抛错', async () => {
    const probe = await probeTool('hubagent-definitely-not-a-command', ['--version'])
    expect(probe.available).toBe(false)
  })
})
