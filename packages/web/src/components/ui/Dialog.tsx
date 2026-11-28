import type { JSX } from '@solidjs/web'
import { Dynamic } from '@solidjs/web'
import { createEffect, createUniqueId } from 'solid-js'
import { IconButton } from './IconButton'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  /** Close button label, e.g. the translated "Close". */
  closeLabel: string
  /** Panel width override; settings is a wide two-column surface. */
  panelClass?: string
  /** Body padding override; `p-0` when the content owns its own layout. */
  bodyClass?: string
  /** Settings is a destination, so its own title is the page heading. */
  titleLevel?: 1 | 2
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
        /* 焦点落在面板本身，不落在关闭按钮上：一开窗就满框设色会把注意力从内容上抢走。 */
        dialog.focus()
      } else if (dialog.open) {
        dialog.close()
      }
    },
  )

  return (
    <dialog
      ref={(node) => {
        element = node
        /* 让面板本身可聚焦（JSX 里 dialog 的 tabindex 被类型禁掉）：
           焦点落在内容而非关闭按钮上。 */
        node.tabIndex = -1
      }}
      aria-labelledby={titleId}
      class={`m-auto rounded-panel border border-line-strong bg-surface p-0 text-ink shadow-dialog focus-visible:outline-none ${
        props.panelClass ?? 'w-[min(520px,calc(100vw-32px))]'
      }`}
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
        <Dynamic
          component={props.titleLevel === 1 ? 'h1' : 'h2'}
          id={titleId}
          class="text-section text-ink"
        >
          {props.title}
        </Dynamic>
        <IconButton icon="x" label={props.closeLabel} onClick={() => props.onClose()} />
      </div>
      <div class={props.bodyClass ?? 'px-4 py-4'}>{props.children}</div>
    </dialog>
  )
}
