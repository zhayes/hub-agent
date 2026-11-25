import {
  createToaster,
  Toast,
  ToastDescription,
  ToastRegion,
  ToastTitle,
} from '@ui-sdk/solid/toast'
import { onCleanup } from 'solid-js'

/**
 * One toaster for the whole console. Toasts announce without stealing focus,
 * which is what an approval decision needs: the transcript keeps its place.
 */
const toaster = createToaster()

export function toast(title: string, description?: string): void {
  void toaster(title, description === undefined ? {} : { description })
}

export function dismissToasts(): void {
  void toaster.dismiss()
}

/** Mount once, at the shell. */
export function Toaster() {
  onCleanup(() => dismissToasts())
  return (
    <ToastRegion
      toaster={toaster}
      class="fixed right-4 bottom-4 z-50 flex w-[min(320px,calc(100vw-32px))] flex-col gap-2"
    >
      {() => (
        <Toast class="rounded-panel border border-line-strong bg-surface p-3 shadow-popover">
          <ToastTitle class="text-meta font-medium text-ink" />
          <ToastDescription class="mt-1 break-words text-badge text-ink-2" />
        </Toast>
      )}
    </ToastRegion>
  )
}
