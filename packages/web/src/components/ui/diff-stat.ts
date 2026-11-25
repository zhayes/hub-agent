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
