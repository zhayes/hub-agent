import { describe, expect, it } from 'vitest'
import { CLI_EXIT, exitCodeFor, exitCodeForRun } from '../../src/interfaces/cli/exit-codes'
import { HubError } from '../../src/shared/errors'

describe('cli-exit-codes：0/2/3/4/5', () => {
  it('错误码映射', () => {
    expect(exitCodeFor(new HubError('CONFIG_INVALID', 'bad'))).toBe(CLI_EXIT.USAGE)
    expect(exitCodeFor(new HubError('NOT_FOUND', 'missing'))).toBe(CLI_EXIT.USAGE)
    expect(exitCodeFor(new HubError('SANDBOX_DENIED', 'denied'))).toBe(CLI_EXIT.APPROVAL_DENIED)
    expect(exitCodeFor(new HubError('VERIFICATION_FAILED', 'fail'))).toBe(
      CLI_EXIT.VERIFICATION_FAILED,
    )
    expect(exitCodeFor(new HubError('UNEXPECTED', 'boom'))).toBe(CLI_EXIT.RUNTIME)
  })

  it('run 结果映射：成功 / 验失败 / 待审批', () => {
    expect(exitCodeForRun({ ok: true, verdict: 'pass' })).toBe(0)
    expect(exitCodeForRun({ ok: false, verdict: 'fail' })).toBe(4)
    expect(
      exitCodeForRun({
        ok: false,
        verdict: 'fail',
        approval: { status: 'pending' },
      }),
    ).toBe(3)
  })
})
