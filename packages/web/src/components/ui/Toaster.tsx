import type { JSX } from '@solidjs/web'
import { Dynamic } from '@solidjs/web'
import { type Component, createSignal, Show } from 'solid-js'

/**
 * Toast surface for the console.
 *
 * Toasts are only ever triggered by a user action (approve, save, delete), and
 * the SDK's toast foundation is a large share of the shell bundle, so it is
 * imported on the first toast instead of at boot. This file must stay tiny:
 * the shell imports it eagerly.
 *
 * Calls made before the module arrives are queued and flushed once the region
 * is actually mounted, so the first toast is never dropped — only slightly
 * delayed.
 */
interface PendingToast {
  title: string
  description?: string
}

let emit: ((title: string, description?: string) => void) | undefined
let mounted = false
let loading = false
const pending: PendingToast[] = []

const [region, setRegion] = createSignal<Component<{ onReady: () => void }>>()

function flush(): void {
  const show = emit
  if (show === undefined || !mounted) return
  while (pending.length > 0) {
    const item = pending.shift()
    if (item === undefined) continue
    show(item.title, item.description)
  }
}

export function toast(title: string, description?: string): void {
  if (emit !== undefined && mounted) {
    emit(title, description)
    return
  }
  pending.push(description === undefined ? { title } : { title, description })
  if (loading) return
  loading = true
  void import('./toast-region').then((module) => {
    emit = module.show
    setRegion(() => module.Region)
  })
}

/** Mount once, at the shell. Renders nothing until the first toast. */
export function Toaster(): JSX.Element {
  return (
    <Show when={region()}>
      {(component) => (
        <Dynamic
          component={component()}
          onReady={() => {
            mounted = true
            flush()
          }}
        />
      )}
    </Show>
  )
}
