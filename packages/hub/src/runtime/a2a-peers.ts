import { createHash, timingSafeEqual } from 'node:crypto'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

export interface Peer {
  id: string
  displayName: string
  status: 'trusted' | 'revoked'
  createdAt: string
  revokedAt?: string
}

interface PeerRow {
  id: string
  display_name: string
  token_hash: string
  status: string
  created_at: string
  revoked_at: string | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 注册一个入站 Peer。
 *
 * token 只存 sha256（ADR 0026）；返回值里的明文 token 只在这一刻出现，
 * 调用方负责交给对端。
 */
export function registerPeer(
  db: Db,
  input: { displayName: string; token?: string },
): { peer: Peer; token: string } {
  const token = input.token ?? newId() + newId()
  const id = newId()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO a2a_peers (id, display_name, token_hash, status, created_at)
     VALUES (@id, @displayName, @tokenHash, 'trusted', @createdAt)`,
  ).run({ id, displayName: input.displayName, tokenHash: hashToken(token), createdAt })

  return {
    peer: { id, displayName: input.displayName, status: 'trusted', createdAt },
    token,
  }
}

/** 启动时幂等注册（同一 token 已存在则不报错，便于配置驱动重启）。 */
export function ensurePeer(db: Db, input: { displayName: string; token: string }): string {
  const existing = db
    .prepare('SELECT id FROM a2a_peers WHERE token_hash = ?')
    .get(hashToken(input.token)) as { id: string } | undefined
  if (existing !== undefined) return existing.id

  return registerPeer(db, { displayName: input.displayName, token: input.token }).peer.id
}

/** 本地撤销：立即生效，不依赖对端配合。 */
export function revokePeer(db: Db, peerId: string): boolean {
  const info = db
    .prepare(
      `UPDATE a2a_peers SET status = 'revoked', revoked_at = ?
       WHERE id = ? AND status = 'trusted'`,
    )
    .run(new Date().toISOString(), peerId)
  return info.changes > 0
}

/**
 * 校验入站 token。返回 peerId 或 undefined（未知/已撤销）。
 *
 * 用定长比较避免时序侧信道；先按 hash 精确查表，再比对，避免逐行扫描。
 */
export function verifyPeerToken(db: Db, token: string): string | undefined {
  if (token === '') return undefined
  const row = db
    .prepare(`SELECT id, token_hash, status FROM a2a_peers WHERE token_hash = ?`)
    .get(hashToken(token)) as Pick<PeerRow, 'id' | 'token_hash' | 'status'> | undefined
  if (row === undefined || row.status !== 'trusted') return undefined

  const expected = Buffer.from(row.token_hash, 'utf8')
  const actual = Buffer.from(hashToken(token), 'utf8')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
  return row.id
}

export function listPeers(db: Db): Peer[] {
  const rows = db.prepare('SELECT * FROM a2a_peers ORDER BY created_at ASC').all() as PeerRow[]
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status === 'revoked' ? 'revoked' : 'trusted',
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }))
}

/** 未配置任何 Peer 时，入站一律拒绝（fail-closed）。 */
export function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? undefined
}
