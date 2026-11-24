import { isAbsolute, sep } from 'node:path'
import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import type { Db } from '../../storage/db'
import type {
  AcquireLeaseInput,
  WorkspaceLease,
  WorkspaceLeaseStatus,
  WorkspaceMode,
} from './types'

interface LeaseRow {
  id: string
  project_id: string
  execution_id: string
  mode: string
  path: string
  branch: string | null
  base_ref: string | null
  holder_agent_id: string
  status: string
  acquired_at: string
  expires_at: string | null
  released_at: string | null
}

const DEFAULT_TTL_MS = 2 * 60 * 60_000

function toLease(row: LeaseRow): WorkspaceLease {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    mode: row.mode as WorkspaceMode,
    path: row.path,
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
    holderAgentId: row.holder_agent_id,
    status: row.status as WorkspaceLeaseStatus,
    acquiredAt: row.acquired_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
  }
}

export function sweepExpiredLeases(db: Db, now = new Date()): number {
  const at = now.toISOString()
  const result = db
    .prepare(
      `UPDATE workspace_leases
       SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(at)
  return result.changes
}

function isExpired(lease: WorkspaceLease, now: Date): boolean {
  return lease.expiresAt !== undefined && lease.expiresAt <= now.toISOString()
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}

/**
 * 租约互斥：
 *   - 路径重叠时，写入型租约与任何 active 租约冲突；
 *   - 两个只读 shared 可以共享同一路径；
 *   - 不同 worktree 路径可以并行，这是 M7 的目标。
 *
 * 过期租约会先被 sweep 成 expired，再参与判断。
 */
export function acquireLease(db: Db, input: AcquireLeaseInput): WorkspaceLease {
  if (!isAbsolute(input.path)) {
    throw new HubError('LEASE_CONFLICT', `租约 path 必须是绝对路径：${input.path}`, {
      path: input.path,
    })
  }
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString()

  return db.transaction((): WorkspaceLease => {
    sweepExpiredLeases(db, now)
    const rows = db
      .prepare(
        `SELECT * FROM workspace_leases
         WHERE project_id = ? AND status = 'active'`,
      )
      .all(input.projectId) as LeaseRow[]
    const active = rows.map(toLease).filter((lease) => !isExpired(lease, now))

    const conflict = active.find((lease) => {
      if (!pathsOverlap(lease.path, input.path)) return false
      // 两个只读 shared 可以共享同一路径；其余重叠都视为写入冲突。
      return !(input.mode === 'shared' && lease.mode === 'shared')
    })
    if (conflict !== undefined) {
      throw new HubError('LEASE_CONFLICT', `工作区已被占用：${conflict.path}`, {
        projectId: input.projectId,
        executionId: input.executionId,
        holderExecutionId: conflict.executionId,
        holderAgentId: conflict.holderAgentId,
        path: conflict.path,
      })
    }

    const id = newId()
    db.prepare(
      `INSERT INTO workspace_leases (
         id, project_id, execution_id, mode, path, branch, base_ref,
         holder_agent_id, status, acquired_at, expires_at
       ) VALUES (
         @id, @projectId, @executionId, @mode, @path, @branch, @baseRef,
         @holderAgentId, 'active', @acquiredAt, @expiresAt
       )`,
    ).run({
      id,
      projectId: input.projectId,
      executionId: input.executionId,
      mode: input.mode,
      path: input.path,
      branch: input.branch ?? null,
      baseRef: input.baseRef ?? null,
      holderAgentId: input.holderAgentId,
      acquiredAt: now.toISOString(),
      expiresAt,
    })
    return {
      id,
      projectId: input.projectId,
      executionId: input.executionId,
      mode: input.mode,
      path: input.path,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      holderAgentId: input.holderAgentId,
      status: 'active',
      acquiredAt: now.toISOString(),
      expiresAt,
    }
  })()
}

export function releaseLease(db: Db, leaseId: string): void {
  const info = db
    .prepare(
      `UPDATE workspace_leases
       SET status = 'released', released_at = ?
       WHERE id = ? AND status = 'active'`,
    )
    .run(new Date().toISOString(), leaseId)
  if (info.changes === 0) {
    throw new HubError('LEASE_CONFLICT', `租约不存在或不是 active：${leaseId}`, { leaseId })
  }
}

export function renewLease(db: Db, leaseId: string, ttlMs = DEFAULT_TTL_MS): void {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const info = db
    .prepare(`UPDATE workspace_leases SET expires_at = ? WHERE id = ? AND status = 'active'`)
    .run(expiresAt, leaseId)
  if (info.changes === 0) {
    throw new HubError('LEASE_CONFLICT', `租约不存在或不是 active：${leaseId}`, { leaseId })
  }
}

export function listLeases(db: Db, projectId?: string): WorkspaceLease[] {
  const rows = (
    projectId === undefined
      ? db.prepare('SELECT * FROM workspace_leases ORDER BY acquired_at ASC, id ASC').all()
      : db
          .prepare(
            'SELECT * FROM workspace_leases WHERE project_id = ? ORDER BY acquired_at ASC, id ASC',
          )
          .all(projectId)
  ) as LeaseRow[]
  return rows.map(toLease)
}

export function activeLeases(db: Db, projectId: string): WorkspaceLease[] {
  sweepExpiredLeases(db)
  return listLeases(db, projectId).filter((lease) => lease.status === 'active')
}

export function leasesForExecution(db: Db, executionId: string): WorkspaceLease[] {
  return listLeases(db).filter((lease) => lease.executionId === executionId)
}
