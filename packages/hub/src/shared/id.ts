import { randomInt } from 'node:crypto'

/**
 * ULID：48 位时间戳 + 80 位随机，Crockford Base32 编码（26 字符）。
 * 字典序 ≈ 时间序，适合做主键与日志定位。
 *
 * 注意：同毫秒内**不保证**单调递增。需要严格全序时用 `events.seq`（数据库保证）。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms))
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET.charAt(remaining % 32) + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

function encodeRandom(): string {
  let out = ''
  for (let i = 0; i < 16; i += 1) {
    out += ALPHABET.charAt(randomInt(0, 32))
  }
  return out
}

export function newId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}
