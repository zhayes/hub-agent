import { For } from 'solid-js'
import { fieldControl } from './Field'
import { Icon } from './Icon'

export interface SelectOption {
  value: string
  label: string
}

/**
 * Native `<select>` with our own chevron.
 *
 * The native arrow sits inside the control's padding and butts against the
 * text, so the arrow is hidden (`appearance-none`) and drawn at `right-3` with
 * matching `pr-9` room. Keeps keyboard behaviour, mobile pickers and form
 * semantics from the platform.
 */
export interface SelectInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  options: readonly SelectOption[]
  disabled?: boolean
  class?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function SelectInput(props: SelectInputProps) {
  return (
    <div class={`relative${props.class === undefined ? '' : ` ${props.class}`}`}>
      <select
        id={props.id}
        class={`${fieldControl} cursor-pointer appearance-none pr-9`}
        value={props.value}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <For each={props.options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
      <Icon
        name="chevronDown"
        size={14}
        class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3"
      />
    </div>
  )
}
