import type { HubError } from '../../shared/errors'

export const CLI_EXIT = {
  OK: 0,
  USAGE: 2,
  APPROVAL_DENIED: 3,
  VERIFICATION_FAILED: 4,
  RUNTIME: 5,
} as const

export function exitCodeFor(error: HubError): number {
  switch (error.code) {
    case 'CONFIG_INVALID':
    case 'NOT_FOUND':
    case 'ACTION_REJECTED':
    case 'EVENT_REJECTED':
    case 'LEASE_CONFLICT':
    case 'DELIVERY_CONFLICT':
      return CLI_EXIT.USAGE
    case 'SANDBOX_DENIED':
    case 'SANDBOX_NOT_PROVISIONED':
      return CLI_EXIT.APPROVAL_DENIED
    case 'VERIFICATION_FAILED':
      return CLI_EXIT.VERIFICATION_FAILED
    default:
      return CLI_EXIT.RUNTIME
  }
}

export interface RunExitInput {
  ok: boolean
  verdict?: 'pass' | 'fail' | 'manual_required' | 'not_run'
  approval?: { status: string }
}

export function exitCodeForRun(result: RunExitInput): number {
  if (result.ok) return CLI_EXIT.OK
  if (result.approval?.status === 'pending' || result.approval?.status === 'rejected') {
    return CLI_EXIT.APPROVAL_DENIED
  }
  if (result.verdict === 'fail') return CLI_EXIT.VERIFICATION_FAILED
  return CLI_EXIT.RUNTIME
}
