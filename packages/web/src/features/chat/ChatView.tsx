import type { JSX } from '@solidjs/web'
import { createEffect, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { RichText } from '../../components/ui/CodeBlock'
import { fieldControl } from '../../components/ui/Field'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { LoadingState } from '../../components/ui/LoadingState'
import { StatusBadge, StatusDot } from '../../components/ui/StatusBadge'
import { ThinkingTrace } from '../../components/ui/ThinkingTrace'
import { toast } from '../../components/ui/Toaster'
import { type ToolChip, ToolChips } from '../../components/ui/ToolChips'
import {
  api,
  type ChatMessage,
  type ChatThread,
  type ChatThreadSummary,
  chatApi,
  getToken,
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

/* Pane widths live in state so they can be dragged; mobile stays a single
   column through the max-width utility below. */
const MOBILE_ONLY = 'hidden max-[860px]:grid'

const LEFT_MIN = 220
const LEFT_MAX = 460
const RIGHT_MIN = 220
const RIGHT_MAX = 460

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function storedWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? clampWidth(parsed, min, max) : fallback
}

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
  const [menuIndex, setMenuIndex] = createSignal(0)
  const [leftCollapsed, setLeftCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.left') === 'collapsed',
  )
  const [rightCollapsed, setRightCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.right') === 'collapsed',
  )
  const [leftWidth, setLeftWidth] = createSignal(
    storedWidth('hubagent.chat.leftWidth', 300, LEFT_MIN, LEFT_MAX),
  )
  const [rightWidth, setRightWidth] = createSignal(
    storedWidth('hubagent.chat.rightWidth', 300, RIGHT_MIN, RIGHT_MAX),
  )
  const [wide, setWide] = createSignal(
    typeof window === 'undefined' ? false : window.matchMedia('(min-width: 861px)').matches,
  )
  /* The context pane is CSS-hidden below 1100px (`max-[1100px]:hidden`), so the
     grid must not reserve a column for it there — otherwise the transcript gets
     squeezed by an invisible 300px gutter. */
  const [wideContext, setWideContext] = createSignal(
    typeof window === 'undefined' ? false : window.matchMedia('(min-width: 1100px)').matches,
  )
  const [mobileThreads, setMobileThreads] = createSignal(false)
  let poll: ReturnType<typeof setInterval> | undefined
  let stream: EventSource | undefined
  let streamSeq: number | undefined
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

  const stopStream = (): void => {
    stream?.close()
    stream = undefined
  }

  const stopWatching = (): void => {
    stopStream()
    stopPolling()
  }

  /* Incremental push. Messages are appended as the hub writes them, so the
     transcript no longer re-renders the whole page every second. */
  const watch = (id: string): void => {
    stopWatching()
    const token = getToken()
    if (token === '' || typeof EventSource === 'undefined') {
      startPolling(id)
      return
    }
    const after = streamSeq === undefined ? '' : `&after=${streamSeq}`
    const source = new EventSource(
      `/api/v1/chat/threads/${encodeURIComponent(id)}/stream?token=${encodeURIComponent(token)}${after}`,
    )
    stream = source

    source.addEventListener('message', (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as ChatMessage
      const id = Number.parseInt((event as MessageEvent<string>).lastEventId, 10)
      if (Number.isFinite(id)) streamSeq = id
      setMessages((previous) =>
        previous.some((item) => item.id === message.id) ? previous : [...previous, message],
      )
      if (stick || isNearBottom()) queueMicrotask(scrollToBottom)
    })

    source.addEventListener('status', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { status: string }
      setThread((previous) =>
        previous === undefined ? previous : { ...previous, status: payload.status },
      )
      if (payload.status !== 'active') {
        stopStream()
        void loadThreads()
      }
    })

    source.addEventListener('error', () => {
      /* Reconnect loops against a rejected token or a missing route are worse
         than a slow poll; fall back once and let the poll carry it. */
      stopStream()
      if (poll === undefined) startPolling(id)
    })
  }

  const loadThread = async (id: string): Promise<void> => {
    /* Without credentials the request falls through to the dev server's HTML
       fallback and surfaces as "Unexpected token '<'". The shell already shows
       the token banner, so stay quiet instead of painting a decode error. */
    if (getToken() === '') return
    try {
      setError('')
      const shouldStick = stick
      const detail = await chatApi.thread(id, { limit: 100 })
      streamSeq = undefined
      setThread(detail.thread)
      /* Same thread → merge, so a refresh cannot drop a message the stream
         already delivered. Different thread → replace outright. */
      setMessages((previous) => {
        if (previous[0]?.threadId !== detail.thread.id) return detail.messages
        const seen = new Set(previous.map((message) => message.id))
        return [...previous, ...detail.messages.filter((message) => !seen.has(message.id))]
      })
      setHasMore(detail.messages.length === 100)
      if (shouldStick) queueMicrotask(scrollToBottom)
      if (detail.thread.status === 'active') watch(id)
      else stopWatching()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadThreads = async (): Promise<void> => {
    if (getToken() === '') return
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
      watch(id)
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
      toast(props.t(action))
      const current = thread()
      if (current !== undefined) {
        if (action === 'approve') {
          const resumed = await chatApi.resume(current.id)
          setThread(resumed.thread)
          setMessages(resumed.messages)
          stick = true
          queueMicrotask(scrollToBottom)
          watch(current.id)
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
      watch(current.id)
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

  /* Grid columns are inline only when the three-pane layout is on screen; on
     phones the max-width utilities keep it a single column. */
  onSettled(() => {
    const wideQuery = window.matchMedia('(min-width: 861px)')
    const contextQuery = window.matchMedia('(min-width: 1100px)')
    const updateWide = (): void => {
      setWide(wideQuery.matches)
    }
    const updateContext = (): void => {
      setWideContext(contextQuery.matches)
    }
    wideQuery.addEventListener('change', updateWide)
    contextQuery.addEventListener('change', updateContext)
    return () => {
      wideQuery.removeEventListener('change', updateWide)
      contextQuery.removeEventListener('change', updateContext)
    }
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
    stopWatching()
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

  /* `/` at the start of the box lists commands; a trailing `@word` mentions a task.
     The menu is derived from the text, so it cannot drift from what is typed. */
  interface MenuItem {
    id: string
    label: string
    hint?: string
  }

  const menu = (): { kind: 'slash' | 'mention'; items: MenuItem[] } | undefined => {
    const value = text()
    if (value.startsWith('/')) {
      const query = value.slice(1).toLowerCase()
      const commands: MenuItem[] = [
        { id: 'run', label: props.t('run'), hint: '/run' },
        { id: 'ask', label: props.t('ask'), hint: '/ask' },
        { id: 'new', label: props.t('newThread'), hint: '/new' },
        { id: 'context', label: props.t('threadContext'), hint: '/context' },
      ]
      return {
        kind: 'slash',
        items: commands.filter((item) => item.id.includes(query)),
      }
    }
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value)
    if (match === null) return undefined
    const query = (match[1] ?? '').toLowerCase()
    return {
      kind: 'mention',
      items: props.tasks
        .filter(
          (task) =>
            task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query),
        )
        .slice(0, 6)
        .map((task) => ({ id: task.id, label: task.title })),
    }
  }

  const applyMenuItem = (item: MenuItem): void => {
    const current = menu()
    setMenuIndex(0)
    if (current === undefined) return
    if (current.kind === 'mention') {
      setText((value) => value.replace(/@[^\s@]*$/, `@${item.label} `))
      return
    }
    setText('')
    if (item.id === 'run') setMode('run')
    else if (item.id === 'ask') setMode('ask')
    else if (item.id === 'new') void newThread()
    else if (item.id === 'context') setPane('right', !rightCollapsed())
  }

  const submitOnEnter = (event: KeyboardEvent): void => {
    const current = menu()
    if (current !== undefined && current.items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((index) => {
          const next = index + delta
          if (next < 0) return current.items.length - 1
          return next >= current.items.length ? 0 : next
        })
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setText('')
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const item = current.items[menuIndex()] ?? current.items[0]
        if (item !== undefined) applyMenuItem(item)
        return
      }
    }
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

  /* Each pane is pinned to its own column. A collapsed pane renders with
     `display: none`, which takes it out of the grid — and then auto-placement
     pulls the remaining panes one column left: the transcript would get 0px and
     the context pane would swallow the middle. Pinning makes collapse purely
     visual. */
  const gridStyle = (): JSX.CSSProperties | undefined => {
    if (!wide()) return undefined
    const left = leftCollapsed() ? 0 : leftWidth()
    /* Below 1100px the context pane is not on screen at all. Collapsed means
       gone, not a 48px rail: the toggle in the chat header is the only control
       for it, so nothing needs to stay visible inside the pane. */
    const right = wideContext() && !rightCollapsed() ? rightWidth() : 0
    return { 'grid-template-columns': `${left}px minmax(0,1fr) ${right}px` }
  }

  const columnStyle = (index: 1 | 2 | 3): JSX.CSSProperties | undefined =>
    wide() ? { 'grid-column': String(index) } : undefined

  const startDrag = (side: 'left' | 'right', event: PointerEvent): void => {
    if (!wide()) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'left' ? leftWidth() : rightWidth()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX
      if (side === 'left') {
        setLeftWidth(clampWidth(startWidth + delta, LEFT_MIN, LEFT_MAX))
      } else {
        setRightWidth(clampWidth(startWidth - delta, RIGHT_MIN, RIGHT_MAX))
      }
    }
    const stop = (): void => {
      target.releasePointerCapture?.(event.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
      target.removeEventListener('pointercancel', stop)
      localStorage.setItem('hubagent.chat.leftWidth', String(leftWidth()))
      localStorage.setItem('hubagent.chat.rightWidth', String(rightWidth()))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
    target.addEventListener('pointercancel', stop)
  }

  const nudge = (side: 'left' | 'right', event: KeyboardEvent): void => {
    const step = event.shiftKey ? 48 : 16
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const grow = event.key === (side === 'left' ? 'ArrowRight' : 'ArrowLeft')
    if (side === 'left') {
      setLeftWidth(clampWidth(leftWidth() + (grow ? step : -step), LEFT_MIN, LEFT_MAX))
    } else {
      setRightWidth(clampWidth(rightWidth() + (grow ? step : -step), RIGHT_MIN, RIGHT_MAX))
    }
  }

  return (
    <div class="grid min-h-0 flex-1 max-[860px]:grid-cols-1" style={gridStyle()}>
      <aside
        class={`relative min-h-0 min-w-0 flex-col overflow-hidden border-r border-line bg-canvas max-[860px]:border-r-0 ${
          leftCollapsed() ? 'hidden' : 'flex'
        } ${mobileThreads() ? 'max-[860px]:flex' : 'max-[860px]:hidden'}`}
        aria-label={props.t('threads')}
        style={columnStyle(1)}
      >
        <div class="flex flex-none items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
          <span class="text-meta font-semibold text-ink">{props.t('threads')}</span>
          <div class="flex items-center gap-0.5">
            <IconButton
              icon="chevronLeft"
              label={props.t('chat')}
              class={MOBILE_ONLY}
              onClick={() => setMobileThreads(false)}
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
        <Show when={wide() && !leftCollapsed()}>
          {/* biome-ignore lint/a11y/useSemanticElements: no native element resizes a pane; role=separator is the ARIA pattern for it */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={props.t('threads')}
            aria-valuenow={leftWidth()}
            aria-valuemin={LEFT_MIN}
            aria-valuemax={LEFT_MAX}
            tabindex="0"
            class="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
            onPointerDown={(event) => startDrag('left', event)}
            onKeyDown={(event) => nudge('left', event)}
          />
        </Show>
      </aside>

      <section
        class={`min-h-0 min-w-0 flex-col bg-surface ${mobileThreads() ? 'max-[860px]:hidden' : 'flex max-[860px]:flex'}`}
        aria-label={props.t('chat')}
        style={columnStyle(2)}
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
            {/* The only two layout controls in the console: this one drives the
                thread list (or opens it on phones), the next one the context
                pane. The panes themselves carry no collapse buttons. */}
            <IconButton
              icon="panelLeft"
              label={
                wide()
                  ? leftCollapsed()
                    ? props.t('expandThreads')
                    : props.t('collapseThreads')
                  : props.t('threads')
              }
              pressed={wide() ? !leftCollapsed() : mobileThreads()}
              onClick={() => {
                if (wide()) setPane('left', !leftCollapsed())
                else setMobileThreads(true)
              }}
            />
            <Show when={wideContext()}>
              <IconButton
                icon="panelRight"
                label={rightCollapsed() ? props.t('expandContext') : props.t('collapseContext')}
                pressed={!rightCollapsed()}
                onClick={() => setPane('right', !rightCollapsed())}
              />
            </Show>
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
          class="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5 max-[860px]:px-4 max-[860px]:pt-4 max-[860px]:pb-1"
          role="log"
          aria-live="polite"
          ref={(el) => {
            messagesEl = el
          }}
          onScroll={() => {
            stick = isNearBottom()
          }}
        >
          {/* Reading measure, matching MessageRow's 74ch so the transcript and
              the composer line up instead of the composer running full-bleed. */}
          <div class="mx-auto flex w-full max-w-[74ch] flex-col gap-4">
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
                    streaming={active() && messages().at(-1)?.id === message.id}
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
        </div>

        <form
          class="flex-none border-t border-line bg-surface px-4 pt-2.5 pb-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          {/* Same measure as the transcript, so the composer sits under the text
              instead of stretching across the whole pane. */}
          <div class="mx-auto flex w-full max-w-[74ch] flex-col">
            <label class="visually-hidden" for="chat-composer">
              {props.t('chatPlaceholder')}
            </label>
            <Show when={(menu()?.items.length ?? 0) > 0}>
              <div
                class="mb-1.5 max-h-[220px] overflow-y-auto rounded-panel border border-line bg-surface p-1 shadow-popover"
                role="listbox"
                aria-label={menu()?.kind === 'slash' ? props.t('command') : props.t('tasks')}
              >
                <For each={menu()?.items ?? []}>
                  {(item, index) => (
                    <>
                      {/* biome-ignore lint/a11y/useFocusableInteractive: typeahead listbox; focus must stay in the textarea, options are chosen with arrows */}
                      <div
                        role="option"
                        tabindex="-1"
                        aria-selected={index() === menuIndex() ? 'true' : 'false'}
                        class={`flex cursor-default items-center justify-between gap-3 rounded-control px-2 py-1.5 text-meta ${
                          index() === menuIndex() ? 'bg-hover text-ink' : 'text-ink-2'
                        }`}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          applyMenuItem(item)
                        }}
                      >
                        <span class="truncate">{item.label}</span>
                        <Show when={item.hint !== undefined}>
                          <span class="shrink-0 font-mono text-badge text-ink-3">{item.hint}</span>
                        </Show>
                      </div>
                    </>
                  )}
                </For>
              </div>
            </Show>
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
          </div>
        </form>
      </section>

      <aside
        class={`relative min-h-0 min-w-0 flex-col overflow-hidden border-l border-line bg-canvas max-[1100px]:hidden ${
          rightCollapsed() ? 'hidden' : 'flex'
        }`}
        aria-label={props.t('threadContext')}
        style={columnStyle(3)}
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <div class="mb-3">
            <span class="text-meta font-semibold text-ink">{props.t('threadContext')}</span>
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
        <Show when={wide() && !rightCollapsed()}>
          {/* biome-ignore lint/a11y/useSemanticElements: no native element resizes a pane; role=separator is the ARIA pattern for it */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={props.t('threadContext')}
            aria-valuenow={rightWidth()}
            aria-valuemin={RIGHT_MIN}
            aria-valuemax={RIGHT_MAX}
            tabindex="0"
            class="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
            onPointerDown={(event) => startDrag('right', event)}
            onKeyDown={(event) => nudge('right', event)}
          />
        </Show>
      </aside>
    </div>
  )
}

function MessageRow(props: {
  message: ChatMessage
  t: Translator
  locale: Locale
  /** Last message of a running thread: its tail is genuinely still arriving. */
  streaming: boolean
  onOpenTask: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer: (id: string, answer: string) => void
}) {
  const chips = (): ToolChip[] => {
    const message = props.message
    const list: ToolChip[] = []
    if (message.taskId !== undefined) {
      list.push({
        label: props.t('taskId'),
        icon: 'tasks',
        id: shortenId(message.taskId),
        href: `/tasks/${message.taskId}`,
        title: message.taskId,
      })
    }
    if (message.approvalId !== undefined) {
      list.push({ label: props.t('approvalItems'), icon: 'alert', title: message.approvalId })
    }
    if (message.clarificationId !== undefined) {
      list.push({
        label: props.t('clarification'),
        icon: 'message',
        title: message.clarificationId,
      })
    }
    return list
  }

  const time = (): JSX.Element => <time>{relativeTime(props.locale, props.message.createdAt)}</time>

  if (props.message.role === 'user') {
    return (
      <article class="max-w-[min(100%,74ch)]">
        <div class="mb-1.5 flex items-baseline gap-1.5 text-badge text-ink">
          <span class="font-medium">{props.t('you')}</span>
          <span aria-hidden="true">·</span>
          {time()}
        </div>
        <RichText text={props.message.content} copyLabel={props.t('copy')} />
      </article>
    )
  }

  const plan = (): boolean => props.message.kind === 'plan'

  return (
    <article class="max-w-[min(100%,74ch)]">
      <div class="mb-1.5 flex items-baseline gap-1.5 text-badge text-ink-3">
        <span>{props.t('appName')}</span>
        <span aria-hidden="true">·</span>
        {time()}
      </div>

      <Show
        when={
          chips().length > 0 &&
          props.message.kind !== 'task' &&
          props.message.kind !== 'approval' &&
          props.message.kind !== 'clarification'
        }
      >
        <ToolChips chips={chips()} class="mb-2" />
      </Show>

      <Show
        when={props.message.kind === 'clarification' && props.message.clarificationId !== undefined}
      >
        <ClarificationCard message={props.message} t={props.t} onAnswer={props.onAnswer} />
      </Show>
      <Show when={props.message.kind === 'approval' && props.message.approvalId !== undefined}>
        <div class="rounded-panel border border-line bg-canvas p-3">
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
        <div class="rounded-panel border border-line bg-canvas p-3">
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

      <Show when={plan()}>
        <ThinkingTrace title={props.t('stepPlan')} summary={props.message.content.split('\n')[0]}>
          <RichText
            text={props.message.content}
            copyLabel={props.t('copy')}
            streaming={props.streaming}
            quiet
          />
        </ThinkingTrace>
      </Show>

      <Show
        when={
          props.message.kind !== 'task' &&
          props.message.kind !== 'approval' &&
          props.message.kind !== 'clarification' &&
          !plan()
        }
      >
        <RichText
          text={props.message.content}
          copyLabel={props.t('copy')}
          streaming={props.streaming}
          quiet={props.message.kind === 'result'}
        />
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
