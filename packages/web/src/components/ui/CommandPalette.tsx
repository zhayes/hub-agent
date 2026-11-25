import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@ui-sdk/solid/command'
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from '@ui-sdk/solid/dialog'
import { For, Show } from 'solid-js'

export interface PaletteItem {
  value: string
  label: string
  /** Right-aligned hint, e.g. a key binding or the current value. */
  hint?: string
  disabled?: boolean
}

export interface PaletteGroup {
  label: string
  items: PaletteItem[]
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  placeholder: string
  empty: string
  groups: PaletteGroup[]
  onRun: (value: string) => void
}

/**
 * Keyboard-first jump list. Behaviour (filtering, roving focus, dismissal,
 * focus return) comes from @ui-sdk/solid; only the surface is ours.
 */
export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogBackdrop class="fixed inset-0 z-40 bg-black/45" />
      <DialogContent class="fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-panel border border-line-strong bg-surface shadow-dialog">
        <DialogTitle class="visually-hidden">{props.title}</DialogTitle>
        <Command
          class="flex flex-col"
          onAction={(value) => {
            props.onRun(value)
          }}
        >
          <CommandInput
            aria-label={props.title}
            placeholder={props.placeholder}
            class="h-11 w-full border-0 border-b border-line bg-transparent px-4 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          />
          <CommandEmpty class="px-4 py-3 text-meta text-ink-3">{props.empty}</CommandEmpty>
          <CommandList class="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
            <For each={props.groups}>
              {(group) => (
                <CommandGroup>
                  <CommandGroupLabel class="px-2 py-1.5 text-badge font-medium text-ink-3">
                    {group.label}
                  </CommandGroupLabel>
                  <For each={group.items}>
                    {(item) => (
                      <CommandItem
                        value={item.value}
                        disabled={item.disabled}
                        class="flex h-8 cursor-default items-center justify-between gap-3 rounded-control px-2 text-meta text-ink data-[highlighted]:bg-hover disabled:opacity-45"
                      >
                        <span class="truncate">{item.label}</span>
                        <Show when={item.hint !== undefined}>
                          <CommandShortcut class="shrink-0 font-mono text-badge text-ink-3">
                            {item.hint}
                          </CommandShortcut>
                        </Show>
                      </CommandItem>
                    )}
                  </For>
                </CommandGroup>
              )}
            </For>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
