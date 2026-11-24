/**
 * 稳定错误码。对外（CLI --json / HTTP）只能暴露这里的 code，
 * 不允许把底层异常类型泄漏出去。
 */
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'LOCK_HELD'
  | 'NOT_FOUND'
  | 'BUDGET_EXHAUSTED'
  | 'ACTION_REJECTED'
  | 'VERIFICATION_FAILED'
  | 'LEASE_CONFLICT'
  | 'DELIVERY_CONFLICT'
  | 'HOME_NOT_WRITABLE'
  | 'NODE_TOO_OLD'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_NOT_PROVISIONED'
  | 'SANDBOX_DENIED'
  | 'AGENT_HOST_FAILED'
  | 'ADAPTER_INCOMPATIBLE'
  | 'NO_AGENT_AVAILABLE'
  | 'DOCTOR_FAILED'
  | 'DB_UNAVAILABLE'
  | 'EVENT_REJECTED'
  | 'REPLAY_REJECTED'
  | 'PROJECTION_MISMATCH'
  | 'UNEXPECTED'

export class HubError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'HubError'
    this.code = code
    this.details = details
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function isErrnoWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
