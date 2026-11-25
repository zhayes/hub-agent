import Check from '@lucide/solid/icons/check'
import Search from '@lucide/solid/icons/search'
import type { JSX } from '@solidjs/web'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@ui-sdk/solid/command'
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@ui-sdk/solid/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/solid/select'
import {
  createToaster,
  Toast,
  ToastDescription,
  ToastRegion,
  ToastTitle,
} from '@ui-sdk/solid/toast'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import { ApprovalCard, type ApprovalState } from '../../components/ui/ApprovalCard'
import {
  buttonDanger,
  buttonGhost,
  buttonPrimary,
  buttonSecondary,
  fieldInput,
} from '../../components/ui/button-classes'
import { LoadingState } from '../../components/ui/LoadingState'
import { StreamingText } from '../../components/ui/StreamingText'

const section = 'mt-10 border-t border-line pt-6'
const card = 'rounded-panel border border-line bg-surface p-4'
const label = 'text-meta font-medium text-ink-2'
const chip = 'inline-flex h-5 items-center rounded-full px-2 text-badge'
const commandItem =
  'flex h-8 cursor-default items-center rounded-control px-2 text-body data-[highlighted]:bg-hover'

function Section(props: { title: string; note?: string; children: JSX.Element }) {
  return (
    <section class={section}>
      <h2 class="text-section text-ink">{props.title}</h2>
      <Show when={props.note !== undefined}>
        <p class="mt-1 max-w-[80ch] text-meta text-ink-2">{props.note}</p>
      </Show>
      <div class="mt-4">{props.children}</div>
    </section>
  )
}

const swatches = [
  { name: 'canvas', class: 'bg-canvas' },
  { name: 'surface', class: 'bg-surface' },
  { name: 'subtle', class: 'bg-subtle' },
  { name: 'accent', class: 'bg-accent' },
  { name: 'success', class: 'bg-success' },
  { name: 'warning', class: 'bg-warning' },
  { name: 'danger', class: 'bg-danger' },
]

const statuses = [
  { label: 'running', class: 'bg-accent-soft text-accent', dot: 'bg-accent' },
  { label: 'waiting on you', class: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  { label: 'completed', class: 'bg-success-soft text-success', dot: 'bg-success' },
  { label: 'failed', class: 'bg-danger-soft text-danger', dot: 'bg-danger' },
  { label: 'idle', class: 'bg-subtle text-ink-2', dot: 'bg-ink-3' },
]

export function DevUiView() {
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [streamText, setStreamText] = createSignal(
    'The session cookie is written after requireSession() redirects,',
  )
  const [streaming, setStreaming] = createSignal(true)
  const [approval, setApproval] = createSignal<ApprovalState>('pending')
  const [action, setAction] = createSignal<string>()
  const [rows, setRows] = createSignal(0)
  const [renderMs, setRenderMs] = createSignal<number>()
  const [chunkIndex, setChunkIndex] = createSignal(0)

  const toaster = createToaster()
  onCleanup(() => toaster.dismiss())

  const appendChunk = (): void => {
    const chunks = [
      'so the dashboard bounces back to /login.',
      'The patch moves the read',
      'after the cookie jar sync.',
    ]
    const next = chunks[chunkIndex() % chunks.length] ?? chunks[0]
    setChunkIndex((value) => value + 1)
    setStreamText(`${streamText()} ${next}`)
    setElapsedMs((value) => value + 500)
  }

  const renderManyRows = (): void => {
    const started = performance.now()
    setRows(10_000)
    queueMicrotask(() => setRenderMs(Math.round(performance.now() - started)))
  }

  return (
    <main class="min-h-dvh bg-canvas">
      <div class="mx-auto max-w-[1120px] px-6 py-8 font-sans text-body text-ink">
        <header class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-meta text-ink-3">P0 spike · not shipped</p>
            <h1 class="text-title text-ink">UI gallery</h1>
            <p class="mt-1 max-w-[70ch] text-meta text-ink-2">
              Tailwind tokens, @ui-sdk behaviors, and three chat primitives ported from Beautiful UI
              (MIT). Every demo is driven by explicit state, not a self-playing loop.
            </p>
          </div>
          <a class={buttonSecondary} href="/chat">
            Back to console
          </a>
        </header>

        <Section title="Tokens" note="B · Warm Ink. Contrast measured in docs/UI-SPEC.md §2.">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <For each={swatches}>
              {(swatch) => (
                <div class="text-meta">
                  <div class={`h-12 rounded-control border border-line ${swatch.class}`} />
                  <div class="mt-1.5 text-ink-2">{swatch.name}</div>
                </div>
              )}
            </For>
          </div>
        </Section>

        <Section title="Type" note="Five sizes, three weights, tabular figures.">
          <div class="grid gap-4 lg:grid-cols-2">
            <div class={card}>
              <p class="text-title text-ink">Fix the redirect loop</p>
              <p class="mt-3 text-section text-ink">Run spine</p>
              <p class="mt-3 text-body text-ink">
                RequireSession redirects before the cookie is readable. 1284 ms · task_…CZDN
              </p>
              <p class="mt-2 text-meta text-ink-2">
                Waiting on you · updated 4 minutes ago · try 2
              </p>
              <p class="mt-2 text-badge text-ink-3">badge · 11px</p>
            </div>
            <div class={card}>
              <p class="font-mono text-meta text-ink-2">pnpm vitest run auth --reporter=dot</p>
              <p class="mt-2 font-mono text-meta text-ink-3">exe_…8J9K · 9f2c41ad8 · +14 / −8</p>
              <p class="mt-4 text-body text-ink">中文排版：任务在运行中，等待你的审批。</p>
              <p class="mt-1 text-meta text-ink-2">中文元信息 13px，行高 1.65。</p>
            </div>
          </div>
        </Section>

        <Section title="Controls" note="One primary per screen; ghost for secondary actions.">
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class={buttonPrimary}>
              Approve
            </button>
            <button type="button" class={buttonSecondary}>
              Open task
            </button>
            <button type="button" class={buttonGhost}>
              Reject
            </button>
            <button type="button" class={buttonDanger}>
              Cancel run
            </button>
            <button type="button" class={buttonPrimary} disabled>
              Disabled
            </button>
          </div>

          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class={label}>Bearer token</span>
              <input
                class={fieldInput}
                type="password"
                value="local-token"
                aria-label="Bearer token"
              />
              <span class="text-badge text-ink-3">Stored on this device.</span>
            </label>
            <div class="flex flex-col gap-1.5">
              <span class={label}>Status</span>
              <div class="flex flex-wrap gap-2">
                <For each={statuses}>
                  {(status) => (
                    <span class={`${chip} ${status.class}`}>
                      <span
                        class={`mr-1.5 size-1.5 rounded-full ${status.dot}`}
                        aria-hidden="true"
                      />
                      {status.label}
                    </span>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="@ui-sdk behaviors"
          note="Unstyled parts; only behavior and ARIA come from the SDK."
        >
          <div class="grid gap-4 lg:grid-cols-2">
            <div class={card}>
              <p class={label}>Dialog</p>
              <div class="mt-2">
                <Dialog>
                  <DialogTrigger class={buttonSecondary}>Open dialog</DialogTrigger>
                  <DialogBackdrop class="fixed inset-0 z-40 bg-black/40" />
                  <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-line bg-surface p-5 shadow-dialog">
                    <DialogTitle class="text-section text-ink">Share task</DialogTitle>
                    <DialogDescription class="mt-1 text-meta text-ink-2">
                      Anyone with this link can view the run and its evidence.
                    </DialogDescription>
                    <div class="mt-5 flex justify-end gap-2">
                      <DialogClose class={buttonGhost}>Cancel</DialogClose>
                      <DialogClose class={buttonPrimary}>Done</DialogClose>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            <div class={card}>
              <p class={label}>Select</p>
              <div class="mt-2 max-w-[280px]">
                <Select
                  defaultValue="claude"
                  items={[
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex CLI' },
                    { value: 'aider', label: 'Aider' },
                  ]}
                >
                  <SelectLabel class={label}>Agent</SelectLabel>
                  <SelectTrigger class={`${fieldInput} mt-1.5 flex items-center justify-between`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent class="z-50 min-w-[var(--anchor-width)] rounded-panel border border-line bg-surface p-1 shadow-popover">
                    <SelectItem value="claude" class={commandItem}>
                      Claude Code
                    </SelectItem>
                    <SelectItem value="codex" class={commandItem}>
                      Codex CLI
                    </SelectItem>
                    <SelectItem value="aider" class={commandItem}>
                      Aider
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div class={card}>
              <p class={label}>Command</p>
              <p class="mt-1 text-badge text-ink-3">Last action: {action() ?? '—'}</p>
              <Command
                class="mt-2 overflow-hidden rounded-panel border border-line bg-surface"
                onAction={(value) => setAction(value)}
              >
                <div class="flex items-center gap-2 border-b border-line px-3">
                  <Search size={15} class="text-ink-3" aria-hidden="true" />
                  <CommandInput
                    aria-label="Search commands"
                    placeholder="Jump to…"
                    class="h-10 w-full border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-ring"
                  />
                </div>
                <CommandEmpty class="px-3 py-3 text-meta text-ink-3">
                  No matching command.
                </CommandEmpty>
                <CommandList class="max-h-60 overflow-y-auto p-1">
                  <CommandGroup>
                    <CommandGroupLabel class="px-2 py-1 text-badge text-ink-3">
                      Navigate
                    </CommandGroupLabel>
                    <CommandItem value="tasks" class={commandItem}>
                      Tasks
                    </CommandItem>
                    <CommandItem value="approvals" class={commandItem}>
                      Approvals
                    </CommandItem>
                  </CommandGroup>
                  <CommandSeparator class="my-1 h-px bg-line" />
                  <CommandGroup>
                    <CommandGroupLabel class="px-2 py-1 text-badge text-ink-3">
                      Actions
                    </CommandGroupLabel>
                    <CommandItem value="new-thread" class={commandItem}>
                      New thread
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>

            <div class={card}>
              <p class={label}>Toast</p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  class={buttonSecondary}
                  onClick={() =>
                    toaster('Task archived', {
                      description: 'The regression run is kept for 30 days.',
                    })
                  }
                >
                  Show toast
                </button>
                <button type="button" class={buttonGhost} onClick={() => toaster.dismiss()}>
                  Dismiss all
                </button>
              </div>
              <ToastRegion
                toaster={toaster}
                class="fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2"
              >
                {() => (
                  <Toast class="rounded-panel border border-line bg-surface p-3 shadow-popover">
                    <ToastTitle class="text-[13px] font-medium text-ink" />
                    <ToastDescription class="mt-1 text-meta text-ink-2" />
                  </Toast>
                )}
              </ToastRegion>
            </div>
          </div>
        </Section>

        <Section
          title="Chat primitives"
          note="Ported from Beautiful UI (MIT). Loading, streaming, and approval are the only animated states."
        >
          <div class="grid gap-4 lg:grid-cols-2">
            <div class={card}>
              <p class={label}>Loading</p>
              <div class="mt-3">
                <LoadingState label="Planning" elapsedMs={elapsedMs()} />
              </div>
              <button type="button" class={`${buttonGhost} mt-3`} onClick={appendChunk}>
                Advance 0.5s
              </button>
            </div>

            <div class={card}>
              <p class={label}>Streaming</p>
              <div class="mt-3">
                <StreamingText text={streamText()} streaming={streaming()} />
              </div>
              <div class="mt-3 flex gap-2">
                <button type="button" class={buttonGhost} onClick={appendChunk}>
                  Append chunk
                </button>
                <button type="button" class={buttonGhost} onClick={() => setStreaming(false)}>
                  Close stream
                </button>
              </div>
            </div>

            <div class="lg:col-span-2">
              <p class={label}>Approval</p>
              <div class="mt-2">
                <ApprovalCard
                  title="Push the fix to origin"
                  resource="git push origin fix/auth-redirect-loop"
                  risk="high"
                  state={approval()}
                  onApprove={() => setApproval('approved')}
                  onReject={() => setApproval('rejected')}
                />
              </div>
              <button
                type="button"
                class={`${buttonGhost} mt-3`}
                onClick={() => setApproval('pending')}
              >
                Reset decision
              </button>
            </div>
          </div>
        </Section>

        <Section
          title="Long list probe"
          note="The SDK ships virtualized Select/Combobox, not a standalone virtualizer. This measures the content-visibility fallback for chat history."
        >
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class={buttonSecondary} onClick={renderManyRows}>
              Render 10,000 rows
            </button>
            <button type="button" class={buttonGhost} onClick={() => setRows(0)}>
              Clear
            </button>
            <span class="text-meta text-ink-2">
              {rows() === 0
                ? 'Nothing rendered.'
                : `${rows().toLocaleString('en-US')} rows · ${renderMs() ?? 0}ms to commit`}
            </span>
          </div>
          <Show when={rows() > 0}>
            <div class="mt-3 max-h-[320px] overflow-y-auto rounded-panel border border-line">
              <For each={Array.from({ length: rows() }, (_, index) => index)}>
                {(index) => (
                  <div class="hx-virtual-row flex h-10 items-center justify-between border-b border-line px-3 text-meta">
                    <span class="text-ink-2">message {index}</span>
                    <span class="font-mono text-ink-3">task_…{String(index).padStart(4, '0')}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <p class="mt-2 flex items-center gap-1.5 text-badge text-ink-3">
            <Check size={12} aria-hidden="true" />
            Expected: header and first rows paint immediately; scrolling stays smooth.
          </p>
        </Section>
      </div>
    </main>
  )
}
