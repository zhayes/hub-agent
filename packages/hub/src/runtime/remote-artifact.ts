import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'

/**
 * 远端交付物 manifest（PRD §7.7）。
 *
 * 只存元数据：谁产的（`signerPeerId`）、什么形态（`form`）、完整性（`sha256`/`size`）、
 * 基线（`baseRef`/`baseCommit`/`lockDigest`）与本地验收结论。内容不落库。
 */
export type RemoteArtifactForm = 'patch' | 'commit' | 'bundle' | 'analysis'

export type RemoteArtifactVerdict = 'pass' | 'fail' | 'manual_required'

export interface RemoteArtifact {
  id: string
  remoteTaskRefId: string
  artifactId: string
  form: RemoteArtifactForm
  baseRef?: string
  baseCommit?: string
  lockDigest?: string
  sha256?: string
  size?: number
  mediaType?: string
  signerPeerId: string
  localPath?: string
  verifiedAt?: string
  verdict?: RemoteArtifactVerdict
  createdAt: string
}

interface RemoteArtifactRow {
  id: string
  remote_task_ref_id: string
  artifact_id: string
  form: string
  base_ref: string | null
  base_commit: string | null
  lock_digest: string | null
  sha256: string | null
  size: number | null
  media_type: string | null
  signer_peer_id: string
  local_path: string | null
  verified_at: string | null
  verdict: string | null
  created_at: string
}

function toArtifact(row: RemoteArtifactRow): RemoteArtifact {
  return {
    id: row.id,
    remoteTaskRefId: row.remote_task_ref_id,
    artifactId: row.artifact_id,
    form: row.form as RemoteArtifactForm,
    ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
    ...(row.base_commit === null ? {} : { baseCommit: row.base_commit }),
    ...(row.lock_digest === null ? {} : { lockDigest: row.lock_digest }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    signerPeerId: row.signer_peer_id,
    ...(row.local_path === null ? {} : { localPath: row.local_path }),
    ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
    ...(row.verdict === null ? {} : { verdict: row.verdict as RemoteArtifactVerdict }),
    createdAt: row.created_at,
  }
}

export interface RecordRemoteArtifactInput {
  remoteTaskRefId: string
  artifactId: string
  form: RemoteArtifactForm
  signerPeerId: string
  baseRef?: string
  baseCommit?: string
  lockDigest?: string
  sha256?: string
  size?: number
  mediaType?: string
  now?: Date
}

/** 同一 ref 下同一 `artifactId` 只记一行：重放对账不会把 manifest 撑大。 */
export function recordRemoteArtifact(
  db: Db,
  input: RecordRemoteArtifactInput,
): { artifact: RemoteArtifact; created: boolean } {
  if (input.artifactId === '') {
    throw new HubError('CONFIG_INVALID', '远端交付物缺少 artifactId')
  }
  const id = newId()
  const createdAt = (input.now ?? new Date()).toISOString()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO remote_artifacts (
         id, remote_task_ref_id, artifact_id, form, base_ref, base_commit, lock_digest,
         sha256, size, media_type, signer_peer_id, created_at
       ) VALUES (
         @id, @refId, @artifactId, @form, @baseRef, @baseCommit, @lockDigest,
         @sha256, @size, @mediaType, @signerPeerId, @createdAt
       )`,
    )
    .run({
      id,
      refId: input.remoteTaskRefId,
      artifactId: input.artifactId,
      form: input.form,
      baseRef: input.baseRef ?? null,
      baseCommit: input.baseCommit ?? null,
      lockDigest: input.lockDigest ?? null,
      sha256: input.sha256 ?? null,
      size: input.size ?? null,
      mediaType: input.mediaType ?? null,
      signerPeerId: input.signerPeerId,
      createdAt,
    })

  const row = db
    .prepare('SELECT * FROM remote_artifacts WHERE remote_task_ref_id = ? AND artifact_id = ?')
    .get(input.remoteTaskRefId, input.artifactId) as RemoteArtifactRow | undefined
  if (row === undefined) {
    throw new HubError('DB_UNAVAILABLE', `远端交付物写入后读不到：${input.artifactId}`)
  }
  return { artifact: toArtifact(row), created: result.changes > 0 }
}

export function listRemoteArtifacts(db: Db, remoteTaskRefId: string): RemoteArtifact[] {
  const rows = db
    .prepare(
      `SELECT * FROM remote_artifacts WHERE remote_task_ref_id = ?
       ORDER BY created_at ASC, artifact_id ASC`,
    )
    .all(remoteTaskRefId) as RemoteArtifactRow[]
  return rows.map(toArtifact)
}

/** 记录本地验收结论（`verified_at` 为空时代表“尚未验收”）。 */
export function markArtifactVerified(
  db: Db,
  input: { id: string; verdict: RemoteArtifactVerdict; localPath?: string; now?: Date },
): boolean {
  const info = db
    .prepare(
      `UPDATE remote_artifacts SET verified_at = ?, verdict = ?, local_path = COALESCE(?, local_path)
       WHERE id = ?`,
    )
    .run((input.now ?? new Date()).toISOString(), input.verdict, input.localPath ?? null, input.id)
  return info.changes > 0
}

/** 代码类交付物：必须本地应用 + 验收后才能算成功（PRD §7.7）。 */
export function isCodeArtifact(form: RemoteArtifactForm): boolean {
  return form === 'patch' || form === 'commit' || form === 'bundle'
}
