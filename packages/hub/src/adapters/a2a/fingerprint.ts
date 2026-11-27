import { createHash } from 'node:crypto'

/**
 * 证书指纹：DER 的 sha256，小写 hex。
 *
 * 用自算 sha256 而不是直接读 Node 的 `fingerprint256`，是为了与
 * `openssl x509 -fingerprint -sha256` 的口径一致（后者对 DER 求 sha256，
 * 只是显示成大写冒号分隔）。指纹可以互相比较，但这里统一成小写无冒号。
 */
export function fingerprintOfCertificate(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

/** 把外部传入的指纹统一成小写、无冒号/空白的规范形式。 */
export function normalizeFingerprint(fingerprint: string | undefined): string | null {
  if (fingerprint === undefined) return null
  const normalized = fingerprint.replace(/[\s:]/g, '').toLowerCase()
  return normalized === '' ? null : normalized
}
