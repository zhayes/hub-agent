import { For, Show } from 'solid-js'
import { Icon, type IconName } from './Icon'

export interface ToolChip {
  /** Already translated; becomes the chip's visible label. */
  label: string
  icon: IconName
  /** Short monospace id shown after the label. */
  id?: string
  href?: string
  title?: string
}

export interface ToolChipsProps {
  chips: ToolChip[]
  class?: string
}

/**
 * The references a message carries — task, approval, question — as compact
 * chips. The hub does not persist raw tool names, so a chip names the effect
 * that the runtime recorded rather than inventing a tool call.
 */
export function ToolChips(props: ToolChipsProps) {
  return (
    <Show when={props.chips.length > 0}>
      <div
        class={`flex flex-wrap items-center gap-1.5${props.class === undefined ? '' : ` ${props.class}`}`}
      >
        <For each={props.chips}>
          {(chip) => (
            <Show when={chip.href !== undefined} fallback={<ChipBody chip={chip} />}>
              <a
                class="inline-flex items-center gap-1.5 rounded-full border border-line bg-subtle px-2 py-0.5 text-badge text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                href={chip.href ?? '#'}
                {...(chip.title === undefined ? {} : { title: chip.title })}
              >
                <Icon name={chip.icon} size={11} />
                <span>{chip.label}</span>
                <Show when={chip.id !== undefined}>
                  <span class="font-mono text-ink-3">{chip.id}</span>
                </Show>
              </a>
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}

function ChipBody(props: { chip: ToolChip }) {
  return (
    <span
      class="inline-flex items-center gap-1.5 rounded-full border border-line bg-subtle px-2 py-0.5 text-badge text-ink-2"
      {...(props.chip.title === undefined ? {} : { title: props.chip.title })}
    >
      <Icon name={props.chip.icon} size={11} />
      <span>{props.chip.label}</span>
      <Show when={props.chip.id !== undefined}>
        <span class="font-mono text-ink-3">{props.chip.id}</span>
      </Show>
    </span>
  )
}
