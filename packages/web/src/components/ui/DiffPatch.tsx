import { For, Show } from 'solid-js'
import { type PatchFile, parseUnifiedDiff } from './diff-stat'

export interface DiffPatchProps {
  patch: string
  truncated?: boolean
  /** Already translated; shown when the patch hit the storage cap. */
  limitLabel: string
  class?: string
}

const lineTone: Record<string, string> = {
  add: 'bg-success-soft text-success',
  del: 'bg-danger-soft text-danger',
  context: 'text-ink-2',
}

/** Unified patch from `git diff`. Hunk text is shown verbatim; nothing is summed up. */
export function DiffPatch(props: DiffPatchProps) {
  const files = (): PatchFile[] => parseUnifiedDiff(props.patch)

  return (
    <Show
      when={files().length > 0}
      fallback={
        <pre class="overflow-x-auto rounded-control bg-subtle px-3 py-2.5 font-mono text-meta whitespace-pre text-ink-2">
          {props.patch}
        </pre>
      }
    >
      <div
        class={`overflow-hidden rounded-control border border-line bg-canvas${props.class === undefined ? '' : ` ${props.class}`}`}
      >
        <For each={files()}>
          {(file) => (
            <section class="border-b border-line last:border-b-0">
              <div class="flex items-baseline justify-between gap-3 bg-subtle px-3 py-1.5">
                <span class="min-w-0 truncate font-mono text-badge text-ink" title={file.path}>
                  {file.path}
                </span>
                <Show when={file.note !== undefined}>
                  <span class="shrink-0 text-badge text-ink-3">{file.note}</span>
                </Show>
              </div>
              <For each={file.hunks}>
                {(hunk) => (
                  <>
                    <div class="bg-subtle px-3 py-0.5 font-mono text-badge text-accent">
                      {hunk.header}
                    </div>
                    <For each={hunk.lines}>
                      {(line) => (
                        <div
                          class={`px-3 font-mono text-badge leading-relaxed whitespace-pre ${lineTone[line.kind] ?? 'text-ink-2'}`}
                        >
                          <span aria-hidden="true">
                            {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                          </span>
                          {line.text}
                        </div>
                      )}
                    </For>
                  </>
                )}
              </For>
            </section>
          )}
        </For>
        <Show when={props.truncated === true}>
          <div class="border-t border-line bg-warning-soft px-3 py-1.5 text-badge text-warning">
            {props.limitLabel}
          </div>
        </Show>
      </div>
    </Show>
  )
}
