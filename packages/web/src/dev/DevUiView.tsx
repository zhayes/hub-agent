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
import { ApprovalCard, type ApprovalState } from '../components/ui/ApprovalCard'
import { Button, buttonClass } from '../components/ui/Button'
import { RichText } from '../components/ui/CodeBlock'
import { DiffPatch } from '../components/ui/DiffPatch'
import { DiffView } from '../components/ui/DiffView'
import { Field, fieldControl } from '../components/ui/Field'
import { LoadingState } from '../components/ui/LoadingState'
import { Panel } from '../components/ui/Panel'
import { SelectInput } from '../components/ui/SelectInput'
import { StatusBadge, StatusDot } from '../components/ui/StatusBadge'
import { StreamingText } from '../components/ui/StreamingText'
import { Tab, TabList, TabPanel, Tabs } from '../components/ui/Tabs'
import { TextInput } from '../components/ui/TextInput'
import { ThinkingTrace } from '../components/ui/ThinkingTrace'
import { ToolChips } from '../components/ui/ToolChips'

const section = 'mt-10 border-t border-line pt-6'
const card = 'rounded-panel border border-line bg-surface p-4'
const label = 'text-meta font-medium text-ink-2'
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
  { status: 'running', label: 'running' },
  { status: 'waiting_approval', label: 'waiting on you' },
  { status: 'completed', label: 'completed' },
  { status: 'failed', label: 'failed' },
  { status: 'idle', label: 'idle' },
]

const patchSample = [
  'diff --git a/src/auth/session.ts b/src/auth/session.ts',
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -12,7 +12,9 @@ export async function requireSession()',
  '   const jar = await cookieJar()',
  '-  const session = readSession(jar)',
  '+  const synced = await jar.sync()',
  '+  const session = readSession(synced)',
  '   if (session === undefined) {',
  '     redirect("/login")',
  '     return undefined',
].join('\n')

const diffSample =
  ' src/auth/session.ts | 14 +++++++++-----\n src/auth/cookie.ts  |  8 ++++----\n 2 files changed, 14 insertions(+), 8 deletions(-)'

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
            <p class="text-meta text-ink-3">P1 · not shipped</p>
            <h1 class="text-title text-ink">UI gallery</h1>
            <p class="mt-1 max-w-[70ch] text-meta text-ink-2">
              Tailwind tokens, five primitives, @ui-sdk behaviors and three chat primitives ported
              from Beautiful UI (MIT). Every demo is driven by explicit state, not a self-playing
              loop.
            </p>
          </div>
          <a class={buttonClass({ variant: 'secondary' })} href="/chat">
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

        <Section
          title="Primitives"
          note="The five P1 primitives. One primary per screen; ghost for secondary actions."
        >
          <div class="flex flex-wrap items-center gap-2">
            <Button>Approve</Button>
            <Button variant="secondary">Open task</Button>
            <Button variant="ghost">Reject</Button>
            <Button variant="danger">Cancel run</Button>
            <Button disabled>Disabled</Button>
            <Button variant="secondary" size="sm">
              Small
            </Button>
          </div>

          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Bearer token" hint="Stored on this device.">
              {(control) => (
                <TextInput
                  {...control}
                  type="password"
                  value="local-token"
                  onInput={() => undefined}
                />
              )}
            </Field>
            <Field label="Daemon URL" error="Must be a loopback address.">
              {(control) => (
                <TextInput
                  {...control}
                  mono
                  value="http://0.0.0.0:8787"
                  onInput={() => undefined}
                />
              )}
            </Field>
            <Field label="Protocol">
              {(control) => (
                <SelectInput
                  {...control}
                  value="openai-completions"
                  onChange={() => undefined}
                  options={[
                    { value: 'openai-completions', label: 'openai-completions' },
                    { value: 'anthropic-messages', label: 'anthropic-messages' },
                  ]}
                />
              )}
            </Field>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <For each={statuses}>
              {(item) => <StatusBadge status={item.status} label={item.label} />}
            </For>
            <span class="h-4 w-px bg-line" aria-hidden="true" />
            <For each={statuses}>
              {(item) => (
                <span class="inline-flex items-center gap-1.5">
                  <StatusDot status={item.status} />
                  <span class="text-meta text-ink-2">{item.label}</span>
                </span>
              )}
            </For>
          </div>
        </Section>

        <Section
          title="Tabs and panels"
          note="Behaviour from @ui-sdk/solid/tabs; surface, track and thumb from tokens."
        >
          <div class="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Execution"
              subtitle="run_…CZDN · 4 minutes ago"
              actions={
                <Button variant="secondary" size="sm">
                  Open
                </Button>
              }
              footer={<span class="text-badge text-ink-3">Verified by runtime</span>}
            >
              <Tabs defaultValue="plan">
                <TabList label="Execution sections">
                  <Tab value="plan">Plan</Tab>
                  <Tab value="evidence">Evidence</Tab>
                  <Tab value="logs">Logs</Tab>
                </TabList>
                <TabPanel value="plan">Three steps: reproduce, patch, verify.</TabPanel>
                <TabPanel value="evidence">9f2c41ad8 · +14 / −8</TabPanel>
                <TabPanel value="logs">pnpm vitest run auth --reporter=dot</TabPanel>
              </Tabs>
            </Panel>
            <Panel
              tone="raised"
              title="Needs your decision"
              subtitle="Push the fix to origin"
              footer={<span class="text-badge text-ink-3">Risk · high</span>}
            >
              <p class="text-meta text-ink-2">
                Approving runs <span class="font-mono">git push</span> on fix/auth-redirect-loop.
              </p>
            </Panel>
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
                  <DialogTrigger class={buttonClass({ variant: 'secondary' })}>
                    Open dialog
                  </DialogTrigger>
                  <DialogBackdrop class="fixed inset-0 z-40 bg-black/40" />
                  <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-line bg-surface p-5 shadow-dialog">
                    <DialogTitle class="text-section text-ink">Share task</DialogTitle>
                    <DialogDescription class="mt-1 text-meta text-ink-2">
                      Anyone with this link can view the run and its evidence.
                    </DialogDescription>
                    <div class="mt-5 flex justify-end gap-2">
                      <DialogClose class={buttonClass({ variant: 'ghost' })}>Cancel</DialogClose>
                      <DialogClose class={buttonClass({ variant: 'primary' })}>Done</DialogClose>
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
                  <SelectTrigger class={`${fieldControl} mt-1.5 flex items-center justify-between`}>
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
                  class={buttonClass({ variant: 'secondary' })}
                  onClick={() =>
                    toaster('Task archived', {
                      description: 'The regression run is kept for 30 days.',
                    })
                  }
                >
                  Show toast
                </button>
                <Button variant="ghost" onClick={() => toaster.dismiss()}>
                  Dismiss all
                </Button>
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
              <Button variant="ghost" class="mt-3" onClick={appendChunk}>
                Advance 0.5s
              </Button>
            </div>

            <div class={card}>
              <p class={label}>Streaming</p>
              <div class="mt-3">
                <StreamingText text={streamText()} streaming={streaming()} />
              </div>
              <div class="mt-3 flex gap-2">
                <Button variant="ghost" onClick={appendChunk}>
                  Append chunk
                </Button>
                <Button variant="ghost" onClick={() => setStreaming(false)}>
                  Close stream
                </Button>
              </div>
            </div>

            <div class="lg:col-span-2">
              <p class={label}>Thinking and tool chips</p>
              <div class="mt-2 flex flex-col gap-3">
                <ThinkingTrace title="Plan" meta="3 subtasks" summary="Reproduce, patch, verify">
                  <p>1. Reproduce the redirect with a session cookie.</p>
                  <p>2. Move the cookie read after the jar sync.</p>
                  <p>3. Verify /dashboard no longer bounces.</p>
                </ThinkingTrace>
                <ToolChips
                  chips={[
                    {
                      label: 'Task ID',
                      icon: 'tasks',
                      id: 'task_…CZDN',
                      href: '/tasks',
                      title: 'task_01HZX9K4CZDN5M2Q',
                    },
                    { label: 'Approvals', icon: 'alert', title: 'ap_1' },
                    { label: 'Clarification', icon: 'message', title: 'cl_1' },
                  ]}
                />
              </div>
            </div>

            <div class="lg:col-span-2">
              <p class={label}>Code blocks</p>
              <div class="mt-2">
                <RichText
                  copyLabel="Copy"
                  text={
                    'Patched the read order:\n\n```ts\nconst session = await jar.sync()\nif (session === undefined) redirect()\n```\n\nThen re-ran the auth suite.'
                  }
                />
              </div>
            </div>

            <div class="lg:col-span-2">
              <p class={label}>Diff</p>
              <p class="mt-1 text-badge text-ink-3">
                Parsed from `git diff --stat`; the hub stores the stat, not the hunks.
              </p>
              <div class="mt-2">
                <DiffView stat={diffSample} />
              </div>
              <div class="mt-3">
                <DiffPatch patch={patchSample} limitLabel="Limit reached — more not loaded" />
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
              <Button variant="ghost" class="mt-3" onClick={() => setApproval('pending')}>
                Reset decision
              </Button>
            </div>
          </div>
        </Section>

        <Section
          title="Long list probe"
          note="The SDK ships virtualized Select/Combobox, not a standalone virtualizer. This measures the content-visibility fallback for chat history."
        >
          <div class="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={renderManyRows}>
              Render 10,000 rows
            </Button>
            <Button variant="ghost" onClick={() => setRows(0)}>
              Clear
            </Button>
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
