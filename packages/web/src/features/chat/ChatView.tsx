import { createEffect, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { StatusBadge } from '../../components/ui/StatusBadge'
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
  const [leftCollapsed, setLeftCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.left') === 'collapsed',
  )
  const [rightCollapsed, setRightCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.right') === 'collapsed',
  )
  let poll: ReturnType<typeof setInterval> | undefined

  const stopPolling = (): void => {
    if (poll !== undefined) clearInterval(poll)
    poll = undefined
  }

  const loadThread = async (id: string): Promise<void> => {
    try {
      setError('')
      const detail = await chatApi.thread(id, { limit: 100 })
      setThread(detail.thread)
      setMessages(detail.messages)
      setHasMore(detail.messages.length === 100)
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
      const older = await chatApi.thread(current.id, { limit: 100, before: first.createdAt })
      setMessages([...older.messages, ...messages()])
      setHasMore(older.messages.length === 100)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const startPolling = (id: string): void => {
    stopPolling()
    poll = setInterval(() => {
      void chatApi
        .thread(id)
        .then((detail) => {
          setThread(detail.thread)
          setMessages(detail.messages)
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
      if (id !== undefined) void loadThread(id)
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

  return (
    <div
      class={`chat-layout${leftCollapsed() ? ' left-collapsed' : ''}${rightCollapsed() ? ' right-collapsed' : ''}`}
    >
      <aside
        class={`chat-threads${leftCollapsed() ? ' collapsed' : ''}`}
        aria-label={props.t('chat')}
      >
        <div class="chat-pane-head">
          <span class="section-heading-label">{props.t('chat')}</span>
          <div class="pane-actions">
            <IconButton
              icon="panelLeft"
              label={leftCollapsed() ? props.t('collapseThreads') : props.t('collapseThreads')}
              onClick={() => setPane('left', !leftCollapsed())}
            />
            <IconButton icon="plus" label={props.t('newThread')} onClick={() => void newThread()} />
          </div>
        </div>
        <input
          class="thread-search"
          type="search"
          aria-label={props.t('searchThreads')}
          placeholder={props.t('searchThreads')}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <div class="thread-list">
          <For each={filteredThreads()}>
            {(item) => (
              <button
                type="button"
                class={`thread-row${thread()?.id === item.id ? ' active' : ''}`}
                onClick={() => props.onOpenThread(item.id)}
                title={item.title}
              >
                <span
                  class={`status-dot ${item.status === 'active' ? 'live' : item.status === 'failed' ? 'offline' : 'live'}`}
                />
                <span class="thread-copy">
                  <span class="thread-title">{item.title}</span>
                  <span class="thread-preview">{item.lastMessage ?? item.title}</span>
                  <span class="thread-meta">
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
            <p class="empty-state">{props.t('noThreads')}</p>
          </Show>
        </div>
      </aside>

      <section class="chat-main" aria-label={props.t('chat')}>
        <header class="chat-head">
          <div class="chat-head-main">
            <div class="chat-title">{thread()?.title ?? props.t('chat')}</div>
            <div class="chat-sub">
              <Show when={thread() !== undefined}>
                <StatusBadge
                  status={thread()?.status ?? 'active'}
                  label={props.t(statusKey(thread()?.status ?? 'active'))}
                />
                <Show when={thread()?.taskId}>
                  <span class="mono">{shortenId(thread()?.taskId ?? '')}</span>
                </Show>
              </Show>
            </div>
          </div>
          <div class="chat-head-actions">
            <IconButton
              icon="panelLeft"
              label={props.t('collapseThreads')}
              onClick={() => setPane('left', !leftCollapsed())}
            />
            <IconButton
              icon="panelRight"
              label={props.t('collapseContext')}
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
          <div class="inline-error" role="alert">
            {error()}
          </div>
        </Show>

        <div class="chat-messages" aria-live="polite">
          <Show
            when={thread() !== undefined}
            fallback={
              <div class="empty-state centered">
                <Icon name="message" size={20} />
                <p>{props.t('selectThread')}</p>
                <button type="button" class="solid-button" onClick={() => void newThread()}>
                  {props.t('newThread')}
                </button>
              </div>
            }
          >
            <Show when={hasMore()}>
              <div class="load-older-wrap">
                <button type="button" class="text-button" onClick={() => void loadOlder()}>
                  {props.t('loadOlder')}
                </button>
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
              <div class="chat-thinking" aria-live="polite">
                <span class="pixel-loader" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span>{props.t('loading')}</span>
              </div>
            </Show>
          </Show>
        </div>

        <form
          class="composer"
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
            value={text()}
            placeholder={
              mode() === 'run' ? props.t('chatPlaceholder') : props.t('chatAskPlaceholder')
            }
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={submitOnEnter}
          />
          <div class="composer-row">
            <div class="mode-switch">
              <button
                type="button"
                class={`mode-button${mode() === 'run' ? ' active' : ''}`}
                aria-pressed={mode() === 'run' ? 'true' : 'false'}
                aria-label={props.t('runTask')}
                title={props.t('runTask')}
                onClick={() => setMode('run')}
              >
                <Icon name="play" size={14} />
                <span class="visually-hidden">{props.t('run')}</span>
              </button>
              <button
                type="button"
                class={`mode-button${mode() === 'ask' ? ' active' : ''}`}
                aria-pressed={mode() === 'ask' ? 'true' : 'false'}
                aria-label={props.t('askStatus')}
                title={props.t('askStatus')}
                onClick={() => setMode('ask')}
              >
                <Icon name="message" size={14} />
                <span class="visually-hidden">{props.t('ask')}</span>
              </button>
            </div>
            <span class="composer-hint">{props.t('chatHint')}</span>
            <button
              type="submit"
              class="send-button"
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
        class={`chat-context${rightCollapsed() ? ' collapsed' : ''}`}
        aria-label={props.t('threadContext')}
      >
        <button
          type="button"
          class="context-rail"
          aria-label={props.t('expandContext')}
          onClick={() => setPane('right', false)}
        >
          <Icon name="panelRight" size={14} />
          <span>{props.t('threadContext')}</span>
        </button>
        <div class="chat-context-body">
          <div class="context-heading">
            <span class="section-heading-label">{props.t('threadContext')}</span>
            <IconButton
              icon="panelRight"
              label={props.t('expandContext')}
              onClick={() => setPane('right', true)}
            />
          </div>
          <Show when={thread()} fallback={<p class="empty-state">{props.t('selectThread')}</p>}>
            {(current) => (
              <>
                <dl class="context-facts">
                  <dt>{props.t('status')}</dt>
                  <dd>
                    <StatusBadge
                      status={current().status}
                      label={props.t(statusKey(current().status))}
                    />
                  </dd>
                  <dt>{props.t('taskId')}</dt>
                  <dd class="mono">{current().taskId ?? '—'}</dd>
                  <dt>{props.t('messages')}</dt>
                  <dd class="num">{messages().length}</dd>
                </dl>
                <Show when={contextTask()}>
                  {(task) => (
                    <a class="context-task-link" href={`/tasks/${task().id}`}>
                      <span>{task().title}</span>
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
  if (props.message.role === 'user') {
    return (
      <article class="chat-message user">
        <div class="chat-message-meta">
          <span>YOU</span>
          <time>{relativeTime(props.locale, props.message.createdAt)}</time>
        </div>
        <p>{props.message.content}</p>
      </article>
    )
  }
  return (
    <article class={`chat-message assistant ${props.message.kind}`}>
      <div class="chat-message-meta">
        <span>HUBAGENT</span>
        <time>{relativeTime(props.locale, props.message.createdAt)}</time>
      </div>
      <Show
        when={props.message.kind === 'clarification' && props.message.clarificationId !== undefined}
      >
        <ClarificationCard message={props.message} t={props.t} onAnswer={props.onAnswer} />
      </Show>
      <Show when={props.message.kind === 'approval' && props.message.approvalId !== undefined}>
        <div class="chat-card approval">
          <div class="chat-card-head">
            <Icon name="alert" size={14} />
            <span>{props.message.content}</span>
          </div>
          <div class="row-actions">
            <button
              type="button"
              class="text-button primary"
              onClick={() => props.onApprove(props.message.approvalId ?? '')}
            >
              {props.t('approve')}
            </button>
            <button
              type="button"
              class="text-button"
              onClick={() => props.onReject(props.message.approvalId ?? '')}
            >
              {props.t('reject')}
            </button>
          </div>
        </div>
      </Show>
      <Show when={props.message.kind === 'task' && props.message.taskId !== undefined}>
        <div class="chat-card">
          <div class="chat-card-head">
            <Icon name="tasks" size={14} />
            <span>{props.message.content}</span>
          </div>
          <button
            type="button"
            class="text-button primary"
            onClick={() => props.onOpenTask(props.message.taskId ?? '')}
          >
            {props.t('openTask')}
          </button>
        </div>
      </Show>
      <Show
        when={
          props.message.kind !== 'task' &&
          props.message.kind !== 'approval' &&
          props.message.kind !== 'clarification'
        }
      >
        <p>{props.message.content}</p>
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
      class="chat-card clarification"
      onSubmit={(event) => {
        event.preventDefault()
        const answer = value().trim()
        if (answer !== '') props.onAnswer(props.message.clarificationId ?? '', answer)
      }}
    >
      <div class="chat-card-head">
        <Icon name="message" size={14} />
        <span>{props.t('clarification')}</span>
      </div>
      <p class="muted">{props.message.content}</p>
      <div class="field-row" style="margin-top:8px">
        <input
          class="text-input"
          aria-label={props.t('answer')}
          placeholder={props.t('answer')}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" class="solid-button">
          {props.t('submit')}
        </button>
      </div>
    </form>
  )
}
