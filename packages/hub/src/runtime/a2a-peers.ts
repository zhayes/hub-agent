import { createHash, timingSafeEqual } from 'node:crypto'
import { normalizeFingerprint } from '../adapters/a2a/fingerprint'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

export interface Peer {
  id: string
  displayName: string
  status: 'trusted' | 'revoked'
  createdAt: string
  revokedAt?: string
  /** 绑定的客户端证书指纹（DER 的 sha256 hex）；token 模式下可空。 */
  certFingerprint?: string
}

interface PeerRow {
  id: string
  display_name: string
  token_hash: string
  status: string
  created_at: string
  revoked_at: string | null
  cert_fingerprint: string | null
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
  input: { displayName: string; token?: string; certFingerprint?: string },
): { peer: Peer; token: string } {
  const token = input.token ?? newId() + newId()
  const id = newId()
  const createdAt = new Date().toISOString()
  const certFingerprint = normalizeFingerprint(input.certFingerprint)
  db.prepare(
    `INSERT INTO a2a_peers (id, display_name, token_hash, status, created_at, cert_fingerprint)
     VALUES (@id, @displayName, @tokenHash, 'trusted', @createdAt, @certFingerprint)`,
  ).run({
    id,
    displayName: input.displayName,
    tokenHash: hashToken(token),
    createdAt,
    certFingerprint,
  })

  return {
    peer: {
      id,
      displayName: input.displayName,
      status: 'trusted',
      createdAt,
      ...(certFingerprint === null ? {} : { certFingerprint }),
    },
    token,
  }
}

/** 启动时幂等注册（同一 token 已存在则不报错，便于配置驱动重启）。 */
export function ensurePeer(
  db: Db,
  input: { displayName: string; token: string; certFingerprint?: string },
): string {
  const existing = db
    .prepare('SELECT id FROM a2a_peers WHERE token_hash = ?')
    .get(hashToken(input.token)) as { id: string } | undefined
  if (existing !== undefined) {
    /* 配置里给了证书指纹但库里还没有：补绑，不重建身份。 */
    if (input.certFingerprint !== undefined) {
      bindPeerCertificate(db, existing.id, input.certFingerprint)
    }
    return existing.id
  }

  return registerPeer(db, {
    displayName: input.displayName,
    token: input.token,
    ...(input.certFingerprint === undefined ? {} : { certFingerprint: input.certFingerprint }),
  }).peer.id
}

/**
 * 把一个客户端证书指纹绑到已存在的 peer。
 *
 * 只写指纹本身（不是证书、不是密钥）；重复绑同一指纹幂等。
 * 若该指纹已被别的 peer 占用，唯一索引会报错——这是故意的，不静默改绑。
 */
export function bindPeerCertificate(db: Db, peerId: string, fingerprint: string): boolean {
  const normalized = normalizeFingerprint(fingerprint)
  if (normalized === null) {
    throw new HubError('CONFIG_INVALID', '证书指纹不能为空', { peerId })
  }
  const info = db
    .prepare(
      `UPDATE a2a_peers SET cert_fingerprint = ?
       WHERE id = ? AND cert_fingerprint IS NULL`,
    )
    .run(normalized, peerId)
  if (info.changes > 0) return true

  /* 已经是同一个指纹 → 幂等成功；是别的指纹 → 拒绝静默改绑。 */
  const current = db.prepare('SELECT cert_fingerprint FROM a2a_peers WHERE id = ?').get(peerId) as
    | { cert_fingerprint: string | null }
    | undefined
  if (current?.cert_fingerprint === normalized) return false
  throw new HubError('EVENT_REJECTED', '该 peer 已绑定别的证书指纹，拒绝静默改绑', { peerId })
}

/**
 * 用客户端证书指纹识别 peer（mTLS 模式）。
 *
 * 只在 `status = 'trusted'` 时返回 peerId；撤销立即生效，不依赖对端配合（ADR 0026）。
 */
export function verifyPeerCertificate(db: Db, fingerprint: string): string | undefined {
  const normalized = normalizeFingerprint(fingerprint)
  if (normalized === null) return undefined
  const row = db
    .prepare('SELECT id, status FROM a2a_peers WHERE cert_fingerprint = ?')
    .get(normalized) as { id: string; status: string } | undefined
  if (row === undefined || row.status !== 'trusted') return undefined
  return row.id
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
    ...(row.cert_fingerprint === null ? {} : { certFingerprint: row.cert_fingerprint }),
  }))
}

/** 未配置任何 Peer 时，入站一律拒绝（fail-closed）。 */
export function bearerOf(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? undefined
}
