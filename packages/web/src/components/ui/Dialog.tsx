import type { JSX } from '@solidjs/web'
import { createEffect, createUniqueId } from 'solid-js'
import { IconButton } from './IconButton'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  /** Close button label, e.g. the translated "Close". */
  closeLabel: string
  children: JSX.Element
}

/**
 * Modal on the native `<dialog>` element.
 *
 * `showModal()` gives us focus trapping, inert background, Escape handling and
 * top-layer stacking from the platform — no SDK popup layer, so opening a
 * dialog does not pull the command palette's ~180 kB foundation into the main
 * bundle. The panel is styled with tokens; `::backdrop` lives in tailwind.css.
 */
export function Dialog(props: DialogProps) {
  const titleId = createUniqueId()
  let element: HTMLDialogElement | undefined

  createEffect(
    () => props.open,
    (open) => {
      const dialog = element
      /* The ref is assigned during creation, so it exists by the first effect run. */
      if (dialog === undefined) return
      if (open) {
        if (!dialog.open) dialog.showModal()
      } else if (dialog.open) {
        dialog.close()
      }
    },
  )

  return (
    <dialog
      ref={(node) => {
        element = node
      }}
      aria-labelledby={titleId}
      class="m-auto w-[min(520px,calc(100vw-32px))] rounded-panel border border-line-strong bg-surface p-0 text-ink shadow-dialog"
      onClose={() => props.onClose()}
      onClick={(event) => {
        /* Backdrop clicks land on the dialog element itself. */
        if (event.target === element) props.onClose()
      }}
      onKeyDown={(event) => {
        /* Native cancel already closes on Escape; this is the fallback when a
           child swallows the keydown before the dialog sees it. */
        if (event.key === 'Escape') props.onClose()
      }}
    >
      <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id={titleId} class="text-section text-ink">
          {props.title}
        </h2>
        <IconButton icon="x" label={props.closeLabel} onClick={() => props.onClose()} />
      </div>
      <div class="px-4 py-4">{props.children}</div>
    </dialog>
  )
}
