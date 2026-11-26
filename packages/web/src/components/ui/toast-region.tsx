import {
  createToaster,
  Toast,
  ToastDescription,
  ToastRegion,
  ToastTitle,
} from '@ui-sdk/solid/toast'
import { onCleanup, onSettled } from 'solid-js'

/**
 * The heavy half of the toast: `@ui-sdk/solid/toast` plus its popup foundation.
 * Loaded on demand by `Toaster.tsx` (see there for why), so this module must
 * never be imported eagerly.
 */
const toaster = createToaster()

export function show(title: string, description?: string): void {
  void toaster(description === undefined ? { title } : { title, description })
}

export interface RegionProps {
  /** Fired once the region is mounted, so queued toasts can be flushed. */
  onReady: () => void
}

export function Region(props: RegionProps) {
  onSettled(() => {
    props.onReady()
  })
  onCleanup(() => {
    void toaster.dismiss()
  })

  return (
    <ToastRegion
      toaster={toaster}
      class="fixed right-4 bottom-4 z-50 flex w-[min(320px,calc(100vw-32px))] flex-col gap-2"
    >
      {() => (
        <Toast class="rounded-panel border border-line-strong bg-surface p-3 shadow-popover">
          <ToastTitle class="text-meta font-medium text-ink" />
          <ToastDescription class="mt-1 wrap-break-word text-badge text-ink-2" />
        </Toast>
      )}
    </ToastRegion>
  )
}
