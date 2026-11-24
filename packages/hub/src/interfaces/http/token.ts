import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tokenPath } from '../../shared/paths'

export function ensureHttpToken(dir: string): { token: string; path: string } {
  const path = tokenPath(dir)
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim()
    if (token.length > 0) return { token, path }
  }
  mkdirSync(dirname(path), { recursive: true })
  const token = randomBytes(32).toString('hex')
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
  return { token, path }
}
