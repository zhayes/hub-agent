import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { HubError } from '../shared/errors'

export type Db = Database.Database

/**
 * 打开数据库并施加基线 PRAGMA（ARCHITECTURE §11.2）。
 *
 * 单写者假设：只有 daemon（或独占的 CLI 维护命令）会写，
 * 因此 synchronous=NORMAL 在 WAL 下是安全且足够快的。
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  let db: Database.Database
  try {
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HubError('DB_UNAVAILABLE', `无法打开数据库 ${path}：${message}`, {
      path,
    })
  }

  return db
}

export function pragmaValue(db: Db, name: string): string {
  const rows = db.pragma(name) as Array<Record<string, unknown>>
  const first = rows[0]
  if (first === undefined) return ''
  const value = Object.values(first)[0]
  return value === undefined || value === null ? '' : String(value)
}

export function integrityCheck(db: Db): string {
  const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>
  const first = rows[0]
  return first === undefined ? '' : String(Object.values(first)[0])
}
