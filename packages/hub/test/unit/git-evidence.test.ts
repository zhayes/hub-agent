import { describe, expect, it } from 'vitest'
import { capPatch } from '../../src/adapters/acp/git-evidence'

describe('capPatch', () => {
  it('keeps a patch that fits', () => {
    const result = capPatch('diff --git a/x b/x', 1024)
    expect(result.truncated).toBe(false)
    expect(result.diff).toBe('diff --git a/x b/x')
  })

  it('truncates at the cap and says so', () => {
    const result = capPatch('x'.repeat(2048), 1024)
    expect(result.truncated).toBe(true)
    expect(result.diff).toHaveLength(1024)
  })

  it('treats an exactly-full patch as whole', () => {
    const result = capPatch('x'.repeat(1024), 1024)
    expect(result.truncated).toBe(false)
    expect(result.diff).toHaveLength(1024)
  })
})
