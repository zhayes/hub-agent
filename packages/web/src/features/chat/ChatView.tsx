import { createEffect, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { fieldControl } from '../../components/ui/Field'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { LoadingState } from '../../components/ui/LoadingState'
import { StatusBadge, StatusDot } from '../../components/ui/StatusBadge'
import {
  api,
  type ChatMessage,
  type ChatThread,
  type ChatThreadSummary,
  chatApi,
  type TaskRow,
} from '../../shared/api'
import { relativeTime, shortenId } from '../../shared/format'
import { type Locale, statusKey, type Translator } from '../../shared/i18n'

export interface ChatViewProps {
  threadId?: string
  locale: Locale
  t: Translator
  events: string[]
  tasks: TaskRow[]
  onOpenThread: (id: string) => void
  onOpenTask: (id: string) => void
}

/* The three panes are a 300 / 1fr / 300 grid; a collapsed pane shrinks to its
   rail. Tailwind only emits classes it can see, so every state is spelled out. */
const layoutCols = {
  open: 'grid-cols-[300px_minmax(0,1fr)_300px] max-[1100px]:grid-cols-[264px_minmax(0,1fr)] max-[860px]:grid-cols-1',
  left: 'grid-cols-[0px_minmax(0,1fr)_300px] max-[1100px]:grid-cols-[0px_minmax(0,1fr)] max-[860px]:grid-cols-1',
  right:
    'grid-cols-[300px_minmax(0,1fr)_48px] max-[1100px]:grid-cols-[264px_minmax(0,1fr)] max-[860px]:grid-cols-1',
  both: 'grid-cols-[0px_minmax(0,1fr)_48px] max-[1100px]:grid-cols-[0px_minmax(0,1fr)] max-[860px]:grid-cols-1',
} as const

const mobileOnly = 'hidden max-[860px]:grid'
const desktopOnly = 'max-[860px]:hidden'

const threadRow =
  'grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-panel px-2.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const emptyState =
  'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2'
const centeredEmpty =
  'flex min-h-[220px] flex-col items-center justify-center gap-2.5 px-8 py-8 text-center text-meta text-ink-2'
const modeButton =
  'inline-flex h-[26px] items-center gap-1.5 rounded-control px-2 text-badge text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export function ChatView(props: ChatViewProps) {
  const [threads, setThreads] = createSignal<ChatThreadSummary[]>([])
  const [thread, setThread] = createSignal<ChatThread>()
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [query, setQuery] = createSignal('')
  const [text, setText] = createSignal('')
  const [mode, setMode] = createSignal<'run' | 'ask'>('run')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [hasMore, setHasMore] = createSignal(false)
  const [thinkingMs, setThinkingMs] = createSignal(0)
  const [leftCollapsed, setLeftCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.left') === 'collapsed',
  )
  const [rightCollapsed, setRightCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.right') === 'collapsed',
  )
  const [mobileThreads, setMobileThreads] = createSignal(false)
  let poll: ReturnType<typeof setInterval> | undefined
  let messagesEl: HTMLDivElement | undefined
  let stick = true

  const scrollToBottom = (): void => {
    if (messagesEl !== undefined) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  const isNearBottom = (): boolean =>
    messagesEl === undefined ||
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80

  const stopPolling = (): void => {
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
  }

  const loadThread = async (id: string): Promise<void> => {
    try {
      setError('')
      const shouldStick = stick
      const detail = await chatApi.thread(id, { limit: 100 })
      setThread(detail.thread)
      setMessages(detail.messages)
      setHasMore(detail.messages.length === 100)
      if (shouldStick) queueMicrotask(scrollToBottom)
      if (detail.thread.status === 'active') startPolling(id)
      else stopPolling()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadThreads = async (): Promise<void> => {
    try {
      const result = await chatApi.threads()
      setThreads(result.threads)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadOlder = async (): Promise<void> => {
    const current = thread()
    const first = messages()[0]
    if (current === undefined || first === undefined || !hasMore()) return
    try {
      const previousHeight = messagesEl?.scrollHeight ?? 0
      const older = await chatApi.thread(current.id, { limit: 100, before: first.createdAt })
      setMessages([...older.messages, ...messages()])
      setHasMore(older.messages.length === 100)
      queueMicrotask(() => {
        if (messagesEl !== undefined) {
          messagesEl.scrollTop = messagesEl.scrollHeight - previousHeight
        }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const startPolling = (id: string): void => {
    stopPolling()
    poll = setInterval(() => {
      const shouldStick = stick || isNearBottom()
      void chatApi
        .thread(id)
        .then((detail) => {
          setThread(detail.thread)
          setMessages(detail.messages)
          if (shouldStick) queueMicrotask(scrollToBottom)
          if (detail.thread.status !== 'active') {
            stopPolling()
            void loadThreads()
          }
        })
        .catch(() => undefined)
    }, 1200)
  }

  const newThread = async (): Promise<void> => {
    try {
      const created = await chatApi.create()
      await loadThreads()
      setMobileThreads(false)
      props.onOpenThread(created.thread.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const send = async (): Promise<void> => {
    const value = text().trim()
    if (value === '' || busy()) return
    setBusy(true)
    setError('')
    try {
      let id = thread()?.id
      if (id === undefined) {
        const created = await chatApi.create(value.slice(0, 72))
        id = created.thread.id
        props.onOpenThread(id)
      }
      const result = await chatApi.post(id, value, mode())
      setThread(result.thread)
      setMessages(result.messages)
      setText('')
      stick = true
      queueMicrotask(scrollToBottom)
      startPolling(id)
      await loadThreads()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const decideApproval = async (
    approvalId: string,
    action: 'approve' | 'reject',
  ): Promise<void> => {
    try {
      await (action === 'approve' ? api.approve(approvalId) : api.reject(approvalId))
      const current = thread()
      if (current !== undefined) {
        if (action === 'approve') {
          const resumed = await chatApi.resume(current.id)
          setThread(resumed.thread)
          setMessages(resumed.messages)
          stick = true
          queueMicrotask(scrollToBottom)
          startPolling(current.id)
        } else {
          await loadThread(current.id)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const answerClarification = async (clarificationId: string, answer: string): Promise<void> => {
    const current = thread()
    if (current === undefined) return
    try {
      const result = await chatApi.answer(current.id, clarificationId, answer)
      setThread(result.thread)
      setMessages(result.messages)
      stick = true
      queueMicrotask(scrollToBottom)
      startPolling(current.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onSettled(() => {
    queueMicrotask(() => {
      void loadThreads()
      if (props.threadId !== undefined) void loadThread(props.threadId)
    })
  })

  createEffect(
    () => props.threadId,
    (id) => {
      if (id !== undefined) {
        stick = true
        void loadThread(id)
      }
    },
  )

  onCleanup(() => {
    stopPolling()
  })

  const setPane = (side: 'left' | 'right', value: boolean): void => {
    if (side === 'left') setLeftCollapsed(value)
    else setRightCollapsed(value)
    localStorage.setItem(`hubagent.chat.${side}`, value ? 'collapsed' : 'open')
  }

  const filteredThreads = (): ChatThreadSummary[] => {
    const needle = query().toLowerCase()
    return threads().filter((item) =>
      `${item.title} ${item.lastMessage ?? ''}`.toLowerCase().includes(needle),
    )
  }

  const contextTask = (): TaskRow | undefined => {
    const id = thread()?.taskId
    return id === undefined ? undefined : props.tasks.find((task) => task.id === id)
  }

  const submitOnEnter = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    if (event.isComposing || event.keyCode === 229) return
    void send()
  }

  const active = (): boolean => thread()?.status === 'active'

  /* Real elapsed time for the loading line: no fake progress, just the clock. */
  createEffect(
    () => active(),
    (running) => {
      if (!running) {
        setThinkingMs(0)
        return
      }
      const started = Date.now()
      setThinkingMs(0)
      const clock = setInterval(() => setThinkingMs(Date.now() - started), 250)
      onCleanup(() => clearInterval(clock))
    },
  )

  const cols = (): string => {
    if (leftCollapsed() && rightCollapsed()) return layoutCols.both
    if (leftCollapsed()) return layoutCols.left
    if (rightCollapsed()) return layoutCols.right
    return layoutCols.open
  }

  return (
    <div class={`grid min-h-0 flex-1 ${cols()}`}>
      <aside
        class={`min-h-0 min-w-0 flex-col overflow-hidden border-r border-line bg-canvas max-[860px]:border-r-0 ${
          leftCollapsed() ? 'hidden' : 'flex'
        } ${mobileThreads() ? 'max-[860px]:flex' : 'max-[860px]:hidden'}`}
        aria-label={props.t('threads')}
      >
        <div class="flex flex-none items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
          <span class="text-meta font-semibold text-ink">{props.t('threads')}</span>
          <div class="flex items-center gap-0.5">
            <IconButton
              icon="chevronLeft"
              label={props.t('chat')}
              class={mobileOnly}
              onClick={() => setMobileThreads(false)}
            />
            <IconButton
              icon="panelLeft"
              label={props.t('collapseThreads')}
              class={desktopOnly}
              onClick={() => setPane('left', !leftCollapsed())}
            />
            <IconButton icon="plus" label={props.t('newThread')} onClick={() => void newThread()} />
          </div>
        </div>
        <input
          class="mx-3 mb-2 h-8 flex-none rounded-control border border-line bg-surface px-2.5 text-meta text-ink placeholder:text-ink-3 focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          type="search"
          aria-label={props.t('searchThreads')}
          placeholder={props.t('searchThreads')}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <For each={filteredThreads()}>
            {(item) => (
              <button
                type="button"
                class={`${threadRow} ${thread()?.id === item.id ? 'bg-active' : 'hover:bg-hover'}`}
                onClick={() => {
                  setMobileThreads(false)
                  props.onOpenThread(item.id)
                }}
                title={item.title}
              >
                <StatusDot status={item.status} class="mt-[5px]" />
                <span class="flex min-w-0 flex-col gap-[3px]">
                  <span
                    class={`truncate text-meta ${
                      thread()?.id === item.id ? 'font-semibold text-ink' : 'font-medium text-ink'
                    }`}
                  >
                    {item.title}
                  </span>
                  <span class="line-clamp-2 text-badge leading-snug text-ink-2">
                    {item.lastMessage ?? item.title}
                  </span>
                  <span class="mt-0.5 flex flex-wrap gap-2 text-badge text-ink-3">
                    <span>
                      {item.messageCount} {props.t('messages')}
                    </span>
                    <span>{relativeTime(props.locale, item.updatedAt)}</span>
                  </span>
                </span>
              </button>
            )}
          </For>
          <Show when={filteredThreads().length === 0}>
            <p class={emptyState}>{props.t('noThreads')}</p>
          </Show>
        </div>
      </aside>

      <section
        class={`min-h-0 min-w-0 flex-col bg-surface ${mobileThreads() ? 'max-[860px]:hidden' : 'flex max-[860px]:flex'}`}
        aria-label={props.t('chat')}
      >
        <header class="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div class="min-w-0">
            <div class="truncate text-section font-semibold text-ink">
              {thread()?.title ?? props.t('chat')}
            </div>
            <div class="mt-1 flex items-center gap-2 text-badge text-ink-3">
              <Show when={thread() !== undefined}>
                <StatusBadge
                  status={thread()?.status ?? 'active'}
                  label={props.t(statusKey(thread()?.status ?? 'active'))}
                />
                <Show when={thread()?.taskId}>
                  <span class="font-mono" title={thread()?.taskId}>
                    {shortenId(thread()?.taskId ?? '')}
                  </span>
                </Show>
              </Show>
            </div>
          </div>
          <div class="flex flex-none items-center gap-0.5">
            <IconButton
              icon="panelLeft"
              label={props.t('threads')}
              class={mobileOnly}
              onClick={() => setMobileThreads(true)}
            />
            <IconButton
              icon="panelLeft"
              label={props.t('collapseThreads')}
              class={desktopOnly}
              onClick={() => setPane('left', !leftCollapsed())}
            />
            <IconButton
              icon="panelRight"
              label={props.t('collapseContext')}
              class={`${desktopOnly} max-[1100px]:hidden`}
              onClick={() => setPane('right', !rightCollapsed())}
            />
            <Show when={thread()?.taskId}>
              <IconButton
                icon="external"
                label={props.t('openTask')}
                onClick={() => props.onOpenTask(thread()?.taskId ?? '')}
              />
            </Show>
          </div>
        </header>

        <Show when={error() !== ''}>
          <div class="flex-none bg-danger-soft px-5 py-2 text-badge text-danger" role="alert">
            {error()}
          </div>
        </Show>

        <div
          class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 max-[860px]:px-4 max-[860px]:pt-4 max-[860px]:pb-1"
          role="log"
          aria-live="polite"
          ref={(el) => {
            messagesEl = el
          }}
          onScroll={() => {
            stick = isNearBottom()
          }}
        >
          <Show
            when={thread() !== undefined}
            fallback={
              <div class={centeredEmpty}>
                <Icon name="message" size={20} />
                <p>{props.t('selectThread')}</p>
                <Button onClick={() => void newThread()}>{props.t('newThread')}</Button>
              </div>
            }
          >
            <Show when={hasMore()}>
              <div class="flex justify-center pb-1">
                <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
                  {props.t('loadOlder')}
                </Button>
              </div>
            </Show>
            <For each={messages()}>
              {(message) => (
                <MessageRow
                  message={message}
                  t={props.t}
                  locale={props.locale}
                  onOpenTask={props.onOpenTask}
                  onApprove={(id) => void decideApproval(id, 'approve')}
                  onReject={(id) => void decideApproval(id, 'reject')}
                  onAnswer={(id, answer) => void answerClarification(id, answer)}
                />
              )}
            </For>
            <Show when={active()}>
              <LoadingState label={props.t('loading')} elapsedMs={thinkingMs()} />
            </Show>
          </Show>
        </div>

        <form
          class="flex-none border-t border-line bg-surface px-4 pt-2.5 pb-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <label class="visually-hidden" for="chat-composer">
            {props.t('chatPlaceholder')}
          </label>
          <textarea
            id="chat-composer"
            rows="2"
            class="block max-h-[180px] min-h-[54px] w-full resize-none rounded-panel border border-line bg-canvas px-3 py-2.5 text-body text-ink placeholder:text-ink-3 focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
            value={text()}
            placeholder={
              mode() === 'run' ? props.t('chatPlaceholder') : props.t('chatAskPlaceholder')
            }
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={submitOnEnter}
          />
          <div class="mt-2 flex items-center gap-2.5">
            <div class="flex flex-none gap-0.5 rounded-panel bg-subtle p-0.5">
              <button
                type="button"
                class={`${modeButton} ${mode() === 'run' ? 'bg-surface font-medium text-ink' : ''}`}
                aria-pressed={mode() === 'run' ? 'true' : 'false'}
                onClick={() => setMode('run')}
              >
                <Icon name="play" size={12} />
                <span>{props.t('run')}</span>
              </button>
              <button
                type="button"
                class={`${modeButton} ${mode() === 'ask' ? 'bg-surface font-medium text-ink' : ''}`}
                aria-pressed={mode() === 'ask' ? 'true' : 'false'}
                onClick={() => setMode('ask')}
              >
                <Icon name="message" size={12} />
                <span>{props.t('ask')}</span>
              </button>
            </div>
            <span class="flex-1 text-right text-badge text-ink-3 max-[560px]:hidden">
              {props.t('chatHint')}
            </span>
            <button
              type="submit"
              class="grid size-[34px] flex-none place-items-center rounded-panel bg-ink text-canvas transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45"
              aria-label={mode() === 'run' ? props.t('runTask') : props.t('askStatus')}
              title={mode() === 'run' ? props.t('runTask') : props.t('askStatus')}
              disabled={busy() || text().trim() === ''}
            >
              <Icon name="arrowUp" size={15} />
            </button>
          </div>
        </form>
      </section>

      <aside
        class="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-line bg-canvas max-[1100px]:hidden"
        aria-label={props.t('threadContext')}
      >
        <button
          type="button"
          class={`w-full items-center gap-2.5 text-badge text-ink-2 [writing-mode:vertical-rl] hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
            rightCollapsed() ? 'flex flex-col py-3.5' : 'hidden'
          }`}
          aria-label={props.t('expandContext')}
          onClick={() => setPane('right', false)}
        >
          <Icon name="panelRight" size={14} />
          <span>{props.t('threadContext')}</span>
        </button>
        <div
          class={`min-h-0 flex-1 overflow-y-auto px-4 py-3.5 ${rightCollapsed() ? 'hidden' : 'block'}`}
        >
          <div class="mb-3 flex items-center justify-between">
            <span class="text-meta font-semibold text-ink">{props.t('threadContext')}</span>
            <IconButton
              icon="panelRight"
              label={props.t('expandContext')}
              onClick={() => setPane('right', true)}
            />
          </div>
          <Show when={thread()} fallback={<p class={emptyState}>{props.t('selectThread')}</p>}>
            {(current) => (
              <>
                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-badge">
                  <dt class="text-ink-3">{props.t('status')}</dt>
                  <dd class="text-right">
                    <StatusBadge
                      status={current().status}
                      label={props.t(statusKey(current().status))}
                    />
                  </dd>
                  <dt class="text-ink-3">{props.t('taskId')}</dt>
                  <dd
                    class="min-w-0 break-words text-right font-mono text-ink"
                    title={current().taskId ?? undefined}
                  >
                    {current().taskId === undefined ? '—' : shortenId(current().taskId ?? '')}
                  </dd>
                  <dt class="text-ink-3">{props.t('messages')}</dt>
                  <dd class="text-right tabular-nums text-ink">{messages().length}</dd>
                </dl>
                <Show when={contextTask()}>
                  {(task) => (
                    <a
                      class="mt-4 flex items-center justify-between gap-2 rounded-panel border border-line bg-surface px-3 py-2.5 text-meta text-ink transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      href={`/tasks/${task().id}`}
                    >
                      <span class="truncate">{task().title}</span>
                      <Icon name="external" size={13} />
                    </a>
                  )}
                </Show>
              </>
            )}
          </Show>
        </div>
      </aside>
    </div>
  )
}

function MessageRow(props: {
  message: ChatMessage
  t: Translator
  locale: Locale
  onOpenTask: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer: (id: string, answer: string) => void
}) {
  const meta = (who: string): string =>
    `mb-1.5 flex items-baseline gap-1.5 text-badge text-ink-3 ${
      props.message.role === 'user' && who === 'you' ? 'text-ink' : ''
    }`

  if (props.message.role === 'user') {
    return (
      <article class="max-w-[min(100%,74ch)]">
        <div class={meta('you')}>
          <span class="font-medium">{props.t('you')}</span>
          <span aria-hidden="true">·</span>
          <time>{relativeTime(props.locale, props.message.createdAt)}</time>
        </div>
        <p class="whitespace-pre-wrap text-body leading-relaxed text-ink">
          {props.message.content}
        </p>
      </article>
    )
  }
  return (
    <article class="max-w-[min(100%,74ch)]">
      <div class="mb-1.5 flex items-baseline gap-1.5 text-badge text-ink-3">
        <span>{props.t('appName')}</span>
        <span aria-hidden="true">·</span>
        <time>{relativeTime(props.locale, props.message.createdAt)}</time>
      </div>
      <Show
        when={props.message.kind === 'clarification' && props.message.clarificationId !== undefined}
      >
        <ClarificationCard message={props.message} t={props.t} onAnswer={props.onAnswer} />
      </Show>
      <Show when={props.message.kind === 'approval' && props.message.approvalId !== undefined}>
        <div class="mt-2 rounded-panel border border-line bg-canvas p-3">
          <div class="flex items-center gap-2 text-meta font-medium text-warning">
            <Icon name="alert" size={14} />
            <span>{props.message.content}</span>
          </div>
          <div class="mt-2.5 flex items-center gap-2">
            <Button onClick={() => props.onApprove(props.message.approvalId ?? '')}>
              {props.t('approve')}
            </Button>
            <Button variant="ghost" onClick={() => props.onReject(props.message.approvalId ?? '')}>
              {props.t('reject')}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={props.message.kind === 'task' && props.message.taskId !== undefined}>
        <div class="mt-2 rounded-panel border border-line bg-canvas p-3">
          <div class="flex items-center gap-2 text-meta font-medium text-ink">
            <Icon name="tasks" size={14} />
            <span>{props.message.content}</span>
          </div>
          <div class="mt-2.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => props.onOpenTask(props.message.taskId ?? '')}
            >
              {props.t('openTask')}
            </Button>
          </div>
        </div>
      </Show>
      <Show
        when={
          props.message.kind !== 'task' &&
          props.message.kind !== 'approval' &&
          props.message.kind !== 'clarification'
        }
      >
        <p
          class={`whitespace-pre-wrap text-body leading-relaxed ${
            props.message.kind === 'plan' || props.message.kind === 'result'
              ? 'text-ink-2'
              : 'text-ink'
          }`}
        >
          {props.message.content}
        </p>
      </Show>
    </article>
  )
}

function ClarificationCard(props: {
  message: ChatMessage
  t: Translator
  onAnswer: (id: string, answer: string) => void
}) {
  const [value, setValue] = createSignal('')
  return (
    <form
      class="mt-2 rounded-panel border border-line bg-canvas p-3"
      onSubmit={(event) => {
        event.preventDefault()
        const answer = value().trim()
        if (answer !== '') props.onAnswer(props.message.clarificationId ?? '', answer)
      }}
    >
      <div class="flex items-center gap-2 text-meta font-medium text-ink">
        <Icon name="message" size={14} />
        <span>{props.t('clarification')}</span>
      </div>
      <p class="mt-1.5 text-meta text-ink-2">{props.message.content}</p>
      <div class="mt-2 flex items-center gap-2">
        <input
          class={`${fieldControl} min-w-0 flex-1`}
          aria-label={props.t('answer')}
          placeholder={props.t('answer')}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <Button type="submit" size="sm">
          {props.t('submit')}
        </Button>
      </div>
    </form>
  )
}
