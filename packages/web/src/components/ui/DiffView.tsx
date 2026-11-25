import { For, Show } from 'solid-js'
import { type DiffFile, type ParsedDiffStat, parseDiffStat } from './diff-stat'

export type { DiffFile, ParsedDiffStat } from './diff-stat'
export { parseDiffStat } from './diff-stat'

export interface DiffViewProps {
  /** Raw `git diff --stat` text as the hub recorded it. */
  stat?: string
  /** Fallback when only the name list was captured. */
  files?: readonly string[]
  class?: string
}

const MAX_MARKS = 40

export function DiffView(props: DiffViewProps) {
  const parsed = (): ParsedDiffStat => parseDiffStat(props.stat ?? '')
  const rows = (): DiffFile[] => {
    const files = parsed().files
    if (files.length > 0) return files
    return (props.files ?? []).map((path) => ({ path, added: 0, removed: 0 }))
  }

  return (
    <Show
      when={rows().length > 0}
      fallback={
        <pre class="overflow-x-auto rounded-control bg-subtle px-3 py-2.5 font-mono text-meta whitespace-pre text-ink-2">
          {props.stat ?? ''}
        </pre>
      }
    >
      <div
        class={`overflow-hidden rounded-control border border-line bg-canvas${props.class === undefined ? '' : ` ${props.class}`}`}
      >
        <ul class="divide-y divide-line">
          <For each={rows()}>
            {(file) => {
              const total = (): number => file.added + file.removed
              const width = (): number => Math.min(MAX_MARKS, Math.max(1, total()))
              const addedWidth = (): string => {
                if (total() === 0) return '0%'
                return `${(file.added / Math.max(width(), total())) * 100}%`
              }
              return (
                <li class="flex items-center gap-3 px-3 py-1.5 text-badge">
                  <span class="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
                    {file.path}
                  </span>
                  <Show when={total() > 0}>
                    <span class="flex h-1.5 w-[72px] shrink-0 overflow-hidden rounded-full bg-danger-soft">
                      <span class="h-full bg-success" style={{ width: addedWidth() }} />
                    </span>
                    <span class="shrink-0 font-mono tabular-nums text-success">+{file.added}</span>
                    <span class="shrink-0 font-mono tabular-nums text-danger">−{file.removed}</span>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
        <Show when={parsed().summary !== undefined}>
          <div class="border-t border-line px-3 py-1.5 font-mono text-badge text-ink-3">
            {parsed().summary}
          </div>
        </Show>
      </div>
    </Show>
  )
}
