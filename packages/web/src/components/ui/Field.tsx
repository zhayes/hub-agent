import type { JSX } from '@solidjs/web'
import { createUniqueId, Show } from 'solid-js'

/** Shared control styling. No preflight, so the UA border must be reset explicitly. */
export const fieldControl =
  'h-9 w-full rounded-control border border-control bg-surface px-3 text-body text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-ring'

export interface FieldControl {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: 'true' | 'false'
}

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  /** Receives the wiring the control needs to stay label- and note-associated. */
  children: (control: FieldControl) => JSX.Element
}

export function Field(props: FieldProps) {
  const id = createUniqueId()
  const noteId = `${id}-note`
  const hasNote = (): boolean => props.error !== undefined || props.hint !== undefined
  const error = (): string | undefined => props.error

  const control = (): FieldControl => ({
    id,
    ...(hasNote() ? { 'aria-describedby': noteId } : {}),
    ...(error() === undefined ? {} : { 'aria-invalid': 'true' as const }),
  })

  return (
    <div class="flex flex-col gap-1.5">
      <label class="text-meta font-medium text-ink-2" for={id}>
        {props.label}
      </label>
      {props.children(control())}
      <Show when={hasNote()}>
        <p id={noteId} class={`text-badge ${error() === undefined ? 'text-ink-3' : 'text-danger'}`}>
          {error() ?? props.hint}
        </p>
      </Show>
    </div>
  )
}
