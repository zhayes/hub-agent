export interface DiffFile {
  path: string
  added: number
  removed: number
}

export interface ParsedDiffStat {
  files: DiffFile[]
  summary?: string
}

/**
 * Parse `git diff --stat` output. The hub captures the stat, not a unified
 * patch, so callers show per-file counts instead of pretending to have hunks.
 */
export function parseDiffStat(stat: string): ParsedDiffStat {
  const files: DiffFile[] = []
  let summary: string | undefined
  for (const line of stat.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/files? changed/.test(trimmed)) {
      summary = trimmed
      continue
    }
    const match = /^(.*?)\s*\|\s*(\d+)\s*([+-]*)$/.exec(trimmed)
    if (match === null) continue
    const path = (match[1] ?? '').trim()
    const marks = match[3] ?? ''
    if (path === '') continue
    files.push({
      path,
      added: (marks.match(/\+/g) ?? []).length,
      removed: (marks.match(/-/g) ?? []).length,
    })
  }
  return { files, ...(summary === undefined ? {} : { summary }) }
}

export type PatchLineKind = 'add' | 'del' | 'context'

export interface PatchLine {
  kind: PatchLineKind
  text: string
}

export interface PatchHunk {
  header: string
  lines: PatchLine[]
}

export interface PatchFile {
  path: string
  /** Set for renames and deletions, shown next to the path. */
  note?: string
  hunks: PatchHunk[]
}

/**
 * Parse a unified diff into files and hunks. Only the parts a reader needs are
 * kept: file headers, hunk headers and the three line kinds. Binary patches
 * and mode-only changes surface as a note with no hunks.
 */
export function parseUnifiedDiff(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let current: PatchFile | undefined
  let hunk: PatchHunk | undefined

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      const path = match?.[2] ?? match?.[1] ?? raw.slice('diff --git '.length)
      current = { path, hunks: [] }
      files.push(current)
      hunk = undefined
      continue
    }
    if (current === undefined) continue

    if (raw.startsWith('@@')) {
      hunk = { header: raw, lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      current.note = 'binary'
      continue
    }
    if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) {
      current.note = raw.trim()
      continue
    }
    if (raw.startsWith('new file mode')) {
      current.note = 'new file'
      continue
    }
    if (raw.startsWith('deleted file mode')) {
      current.note = 'deleted'
      continue
    }
    /* `---`/`+++` before the first hunk are file headers (already skipped
       above); inside a hunk they are content, e.g. a SQL comment. */
    if (hunk === undefined) continue
    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: raw.slice(1) })
      continue
    }
    if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: raw.slice(1) })
      continue
    }
    if (raw.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: raw.slice(1) })
    }
  }

  return files
}
