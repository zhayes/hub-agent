import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'

export type PanelTone = 'flat' | 'raised'

export interface PanelProps {
  title?: string
  subtitle?: string
  actions?: JSX.Element
  footer?: JSX.Element
  /** `raised` adds the card elevation; use it for one surface per screen at most. */
  tone?: PanelTone
  class?: string
  children?: JSX.Element
}

const tones: Record<PanelTone, string> = {
  flat: 'border-line',
  raised: 'border-line-strong shadow-card',
}

export function Panel(props: PanelProps) {
  return (
    <section
      class={`overflow-hidden rounded-panel border bg-surface ${tones[props.tone ?? 'flat']}${props.class === undefined ? '' : ` ${props.class}`}`}
    >
      <Show when={props.title !== undefined}>
        <header class="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <h2 class="text-section text-ink">{props.title}</h2>
            <Show when={props.subtitle !== undefined}>
              <p class="mt-0.5 text-meta text-ink-2">{props.subtitle}</p>
            </Show>
          </div>
          <Show when={props.actions !== undefined}>
            <div class="flex shrink-0 items-center gap-2">{props.actions}</div>
          </Show>
        </header>
      </Show>
      <div class={props.title === undefined ? 'p-4' : 'px-4 py-4'}>{props.children}</div>
      <Show when={props.footer !== undefined}>
        <footer class="border-t border-line bg-canvas/70 px-4 py-2.5">{props.footer}</footer>
      </Show>
    </section>
  )
}
