import { basename } from 'node:path'
import { HubError } from '../../shared/errors'
import { newId } from '../../shared/id'
import type { Db } from '../../storage/db'

export interface ProjectRecord {
  id: string
  name: string
  rootPath: string
  vcs: string
  allowedPaths: string[]
  isolation: string
  createdAt: string
}

interface ProjectRow {
  id: string
  name: string
  root_path: string
  vcs: string
  allowed_paths: string
  isolation: string
  created_at: string
}

function toProject(row: ProjectRow): ProjectRecord {
  let allowedPaths: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.allowed_paths)
    if (Array.isArray(parsed))
      allowedPaths = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    allowedPaths = []
  }
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    vcs: row.vcs,
    allowedPaths,
    isolation: row.isolation,
    createdAt: row.created_at,
  }
}

export function getProject(db: Db, projectId: string): ProjectRecord | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined
  return row === undefined ? undefined : toProject(row)
}

export function ensureProject(db: Db, rootPath: string): ProjectRecord {
  const existing = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
    | ProjectRow
    | undefined
  if (existing !== undefined) return toProject(existing)

  const record: ProjectRecord = {
    id: newId(),
    name: basename(rootPath) || 'project',
    rootPath,
    vcs: 'git',
    allowedPaths: [],
    isolation: 'worktree',
    createdAt: new Date().toISOString(),
  }
  try {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, vcs, allowed_paths, isolation, created_at)
       VALUES (@id, @name, @rootPath, @vcs, @allowedPaths, @isolation, @createdAt)`,
    ).run({
      id: record.id,
      name: record.name,
      rootPath: record.rootPath,
      vcs: record.vcs,
      allowedPaths: JSON.stringify(record.allowedPaths),
      isolation: record.isolation,
      createdAt: record.createdAt,
    })
  } catch (error) {
    throw new HubError('DB_UNAVAILABLE', `无法注册项目：${rootPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  return record
}
