import { fieldControl } from './Field'

/**
 * Native text input on the shared control surface.
 *
 * `Field` owns label/hint wiring; this owns the control itself, so the padding,
 * border, focus ring and font only exist in one place.
 */
export interface TextInputProps {
  id?: string
  value: string
  onInput: (value: string) => void
  type?: 'text' | 'password' | 'search'
  placeholder?: string
  autocomplete?: string
  inputmode?: 'text' | 'numeric' | 'url'
  spellcheck?: boolean
  disabled?: boolean
  /** Focus this control when its <dialog> opens. */
  autofocus?: boolean
  /** Monospace value: ids, URLs, tokens. */
  mono?: boolean
  class?: string
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-invalid'?: 'true' | 'false'
}

export function TextInput(props: TextInputProps) {
  return (
    <input
      id={props.id}
      class={`${fieldControl}${props.mono === true ? ' font-mono' : ''}${props.class === undefined ? '' : ` ${props.class}`}`}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      autocomplete={props.autocomplete ?? 'off'}
      inputmode={props.inputmode}
      spellcheck={props.spellcheck ?? false}
      disabled={props.disabled}
      autofocus={props.autofocus}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      aria-invalid={props['aria-invalid']}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  )
}
