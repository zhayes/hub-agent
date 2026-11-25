import { For } from 'solid-js'

export interface LoadingStateProps {
  /** What the agent is doing, e.g. "Planning" or "Reading files". */
  label?: string
  /** Elapsed time supplied by the caller; the component never runs its own clock. */
  elapsedMs?: number
}

/** Ported from Beautiful UI's Loading State (MIT). Driven by real elapsed time. */
export function LoadingState(props: LoadingStateProps) {
  const seconds = (): string => ((props.elapsedMs ?? 0) / 1000).toFixed(1)

  return (
    <div class="flex items-center gap-3" role="status" aria-live="polite">
      <span class="hx-loading-grid" aria-hidden="true">
        <For each={Array.from({ length: 9 })}>{() => <i />}</For>
      </span>
      <span class="text-meta text-ink-2">
        {props.label ?? 'Working'}
        <span class="mx-1.5 text-ink-3" aria-hidden="true">
          ·
        </span>
        <span class="tabular-nums">{seconds()}s</span>
      </span>
    </div>
  )
}
