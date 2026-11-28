import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { RichText } from '../../components/ui/CodeBlock'
import { Dialog } from '../../components/ui/Dialog'
import { fieldControl } from '../../components/ui/Field'
import { Icon, type IconName } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { LoadingState } from '../../components/ui/LoadingState'
import { ProcessTrace } from '../../components/ui/ProcessTrace'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { ThinkingTrace } from '../../components/ui/ThinkingTrace'
import { toast } from '../../components/ui/Toaster'
import { type ToolChip, ToolChips } from '../../components/ui/ToolChips'
import {
  type AgentRow,
  type ApprovalRow,
  type AuthMethodView,
  api,
  type ChatMessage,
  type ChatRunSettings,
  type ChatThread,
  type ChatThreadSummary,
  type ClarificationView,
  chatApi,
  DEFAULT_RUN_SETTINGS,
  getToken,
  type PermissionMode,
  type ProbeResultView,
  type TaskRow,
  type TaskView,
} from '../../shared/api'
import { deriveAttention } from '../../shared/attention'
import { relativeTime, shortenId } from '../../shared/format'
import { type Locale, type MessageKey, statusKey, type Translator } from '../../shared/i18n'
import { agentBadge, type DockAgent, RunDock, type RunPhase } from './RunDock'
import { RunSettingsDialog } from './RunSettingsDialog'
import {
  forgetThread,
  readCachedSummaries,
  readCachedThread,
  readPermissionMode,
  readUnsavedDraft,
  rememberThread,
  rememberWorkspace,
  writeCachedSummaries,
  writeCachedThread,
  writePermissionMode,
  writeUnsavedDraft,
} from './store'

export interface ChatViewProps {
  threadId?: string
  locale: Locale
  t: Translator
  events: string[]
  tasks: TaskRow[]
  /** 待批的审批（来自全局 store）；dock 要能就地拍板，不能只给个链接。 */
  approvals: ApprovalRow[]
  /** 已注册 Agent：运行设置里选「可用 Agent」（扇出范围）要用。 */
  agents: AgentRow[]
  onOpenThread: (id: string) => void
  onOpenTask: (id: string) => void
  /** 当前 thread 被删除/归档后回到空态。 */
  onClearThread: () => void
}

/* Pane widths live in state so they can be dragged; mobile stays a single
   column through the max-width utility below. */
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

/* Empty states lean on a glyph instead of a paragraph: the shape says "nothing
   here yet" without reading like a manual. */
const emptyGlyph = 'grid size-11 shrink-0 place-items-center rounded-full bg-subtle text-ink-3'
const emptyBlock = 'flex flex-col items-center gap-2 px-4 py-8 text-center text-meta text-ink-3'
const centeredEmpty =
  'flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center text-meta text-ink-2'

/* No thread selected: offer openers instead of instructing the reader. Typing in
   the composer already starts a thread, so a hint only repeated what the input
   does; these chips give the empty pane something to act on. */
const starterPrompts: MessageKey[] = [
  'starterRunning',
  'starterChanged',
  'starterDelegate',
  'starterReview',
]

export function ChatView(props: ChatViewProps) {
  const [threads, setThreads] = createSignal<ChatThreadSummary[]>(readCachedSummaries() ?? [])
  const [thread, setThread] = createSignal<ChatThread>()
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [query, setQuery] = createSignal('')
  const [text, setText] = createSignal(readUnsavedDraft())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  /* 新会话必须先选工作区；已打开的会话用自己的 worktree。 */
  const [workspace, setWorkspace] = createSignal<string>('')
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(readPermissionMode())
  const [runSettingsOpen, setRunSettingsOpen] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(false)
  const [thinkingMs, setThinkingMs] = createSignal(0)
  const [menuIndex, setMenuIndex] = createSignal(0)
  /* 会话历史是抽屉（E 稿）：不占正文列，需要时才从左侧伸出来。 */
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  let searchEl: HTMLInputElement | undefined
  /* 抽屉打开时把焦点送进搜索框：不然 Esc 收不到、键盘用户也出不去。 */
  createEffect(
    () => drawerOpen(),
    (open) => {
      if (open) queueMicrotask(() => searchEl?.focus())
    },
  )
  /* 右侧是“状态/关联任务”的补充信息，默认收起，需要时再开。 */
  const [rightCollapsed, setRightCollapsed] = createSignal(
    localStorage.getItem('hubagent.chat.right') !== 'open',
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
  const [contextWide, setWideContext] = createSignal(
    typeof window === 'undefined' ? false : window.matchMedia('(min-width: 1100px)').matches,
  )
  /* 上下文栏只在“有可看的东西”时占位：没有关联任务时不白占一列。 */
  const wideContext = (): boolean => contextWide() && thread()?.taskId !== undefined
  const [menuFor, setMenuFor] = createSignal<string>()
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 })
  const [renamingId, setRenamingId] = createSignal<string>()
  const [renameDraft, setRenameDraft] = createSignal('')
  const [deleting, setDeleting] = createSignal<ChatThreadSummary>()
  const [taskDetail, setTaskDetail] = createSignal<TaskView>()
  const [taskDetailError, setTaskDetailError] = createSignal('')
  let taskRequestSeq = 0
  let lastResourceTask: string | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let stream: EventSource | undefined
  let streamSeq: number | undefined
  let messagesEl: HTMLDivElement | undefined
  let composerEl: HTMLTextAreaElement | undefined
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

    /* 同一行的原地更新（流式思考、工具状态）：按 id 替换，不新增气泡。 */
    source.addEventListener('message.update', (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as ChatMessage
      setMessages((previous) =>
        previous.some((item) => item.id === message.id)
          ? previous.map((item) => (item.id === message.id ? message : item))
          : [...previous, message],
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
      writeCachedSummaries(result.threads)
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

  /** 弹系统目录框；取消不报错。 */
  const chooseWorkspace = async (): Promise<string | undefined> => {
    if (picking()) return undefined
    setPicking(true)
    setError('')
    try {
      const result = await chatApi.pickDirectory()
      if (result.path === undefined) return undefined
      setWorkspace(result.path)
      rememberWorkspace(result.path)
      /* 旧会话（迁移前没有工作区）选完后立即补上，否则它永远不能执行。 */
      const current = thread()
      if (current !== undefined && (current.worktree ?? '') === '') {
        const updated = await chatApi.setWorkspace(current.id, result.path)
        setThread(updated.thread)
      }
      return result.path
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      setPicking(false)
    }
  }

  /** 当前会话的工作区：已打开会话用它自己的，新建会话用草稿里的。 */
  const currentWorkspace = (): string => thread()?.worktree ?? workspace()

  /**
   * 开一个「还没有会话记录」的草稿：先选目录，然后回到空对话页。
   *
   * 这里**不写库**。以前点“新会话”就 `POST /chat/threads`，结果历史里堆一堆
   * 空的 “New thread”——那些不是会话，只是被点过。真正建线程发生在第一条消息
   * 发送时（`send`），标题也从那句话里取。
   */
  const startDraft = async (): Promise<void> => {
    const chosen = await chooseWorkspace()
    if (chosen === undefined || chosen === '') {
      setError(props.t('workspaceRequired'))
      return
    }
    setWorkspace(chosen)
    rememberWorkspace(chosen)
    setDrawerOpen(false)
    clearCurrentThread()
  }

  const clearCurrentThread = (): void => {
    setThread(undefined)
    setMessages([])
    setHasMore(false)
    streamSeq = undefined
    stopWatching()
    props.onClearThread()
  }

  const beginRename = (item: ChatThreadSummary): void => {
    setMenuFor(undefined)
    setRenamingId(item.id)
    setRenameDraft(item.title)
  }

  const commitRename = async (id: string): Promise<void> => {
    if (renamingId() !== id) return
    const title = renameDraft().trim()
    setRenamingId(undefined)
    if (title === '') return
    try {
      const result = await chatApi.rename(id, title)
      setThreads((list) =>
        list.map((item) => (item.id === id ? { ...item, title: result.thread.title } : item)),
      )
      setThread((current) =>
        current?.id === id ? { ...current, title: result.thread.title } : current,
      )
      toast(props.t('threadRenamed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const archiveThreadNow = async (item: ChatThreadSummary): Promise<void> => {
    setMenuFor(undefined)
    try {
      await chatApi.archive(item.id)
      forgetThread(item.id)
      if (thread()?.id === item.id) clearCurrentThread()
      await loadThreads()
      toast(props.t('threadArchived'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const removeThreadNow = async (item: ChatThreadSummary): Promise<void> => {
    setDeleting(undefined)
    try {
      await chatApi.remove(item.id)
      forgetThread(item.id)
      if (thread()?.id === item.id) clearCurrentThread()
      await loadThreads()
      toast(props.t('threadDeleted'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const send = async (): Promise<void> => {
    const value = text().trim()
    if (value === '' || busy() || active()) return
    setBusy(true)
    setError('')
    try {
      let id = thread()?.id
      if (id === undefined) {
        /* 新建会话必先有工作区；没有就弹系统目录框，取消则不发。 */
        const chosen = currentWorkspace() === '' ? await chooseWorkspace() : currentWorkspace()
        if (chosen === undefined || chosen === '') {
          setError(props.t('workspaceRequired'))
          return
        }
        const created = await chatApi.create({
          worktree: chosen,
          title: value.slice(0, 72),
          ...(permissionMode() === 'workspace-write' ? {} : { permissionMode: permissionMode() }),
        })
        id = created.thread.id
        props.onOpenThread(id)
      }
      const result = await chatApi.post(id, value)
      setThread(result.thread)
      setMessages(result.messages)
      setText('')
      writeUnsavedDraft('')
      writeCachedThread(id, { draft: '' })
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

  /* 先用缓存渲染，再拉服务端：从任务页回来时不会先闪一下空态。 */
  createEffect(
    () => props.threadId,
    (id) => {
      if (id === undefined) return
      stick = true
      const cached = readCachedThread(id)
      if (cached === undefined) {
        setThread(undefined)
        setMessages([])
        setHasMore(false)
        setText('')
        streamSeq = undefined
      } else {
        setThread(cached.thread)
        setMessages(cached.messages)
        setHasMore(cached.hasMore)
        setText(cached.draft ?? '')
        streamSeq = cached.seq
        queueMicrotask(() => {
          if (messagesEl === undefined) return
          messagesEl.scrollTop = cached.scrollTop ?? messagesEl.scrollHeight
          stick = isNearBottom()
        })
      }
      rememberThread(id)
      void loadThread(id)
    },
  )

  /* 缓存只负责“回来的第一帧”；服务端仍是唯一事实来源，别在这里做请求。 */
  createEffect(
    () => ({ thread: thread(), messages: messages(), hasMore: hasMore() }),
    (value) => {
      const current = value.thread
      if (current === undefined) return
      writeCachedThread(current.id, {
        thread: current,
        messages: value.messages,
        hasMore: value.hasMore,
        ...(streamSeq === undefined ? {} : { seq: streamSeq }),
      })
    },
  )

  onCleanup(() => {
    stopElapsedClock()
    const current = thread()
    if (current !== undefined && messagesEl !== undefined) {
      writeCachedThread(current.id, { scrollTop: messagesEl.scrollTop })
    }
    stopWatching()
  })

  /* 右侧上下文栏的开关：只改可视状态，不改变栅格列的存在与否。 */
  const setPane = (value: boolean): void => {
    setRightCollapsed(value)
    localStorage.setItem('hubagent.chat.right', value ? 'collapsed' : 'open')
  }

  /* 新建 thread 的占位标题由后端写成 'New thread'（它靠这个字面量决定何时改名），
     展示层换成本地化文案。 */
  const menuThread = (): ChatThreadSummary | undefined =>
    threads().find((item) => item.id === menuFor())

  const displayTitle = (title: string): string =>
    title === 'New thread' ? props.t('newThread') : title

  /* 状态词：`active` 直译成“active/进行中”读不出“在跑”，统一叫 Running。 */
  const statusLabel = (status: string): string =>
    status === 'active' ? props.t('chatTurnRunning') : props.t(statusKey(status))

  /* 用户目录缩成 `~`：路径是给人看的，不是给 shell 看的。 */
  const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

  const runSettingsDirty = (): boolean => {
    const settings = thread()?.runSettings ?? DEFAULT_RUN_SETTINGS
    return settings.verifyCommands.length > 0 || settings.agents.length > 0
  }

  /* 保存运行设置：只影响后续回合，所以存完刷新线程即可，不碰正在跑的那个。 */
  const saveRunSettings = (settings: ChatRunSettings): void => {
    const current = thread()
    if (current === undefined) return
    setRunSettingsOpen(false)
    void chatApi
      .setRunSettings(current.id, settings)
      .then((result) => setThread(result.thread))
      .then(() => loadThreads())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  /* 权限档 → 文案：头部副行与输入框下方的 chip 共用。 */
  const permissionKey = (
    mode: PermissionMode,
  ): 'permissionReadOnly' | 'permissionWorkspaceWrite' | 'permissionFull' =>
    mode === 'read-only'
      ? 'permissionReadOnly'
      : mode === 'full'
        ? 'permissionFull'
        : 'permissionWorkspaceWrite'

  /* 会话行的状态点：在跑是中性（不是“轮到你”），完成绿、失败红。 */
  const threadDot = (status: string): string => {
    if (status === 'failed' || status === 'error') return 'bg-danger'
    if (status === 'completed') return 'bg-success'
    if (status === 'waiting_approval' || status === 'waiting_input' || status === 'waiting') {
      return 'bg-warning'
    }
    return 'bg-ink-3'
  }

  const threadWaiting = (item: ChatThreadSummary): number =>
    item.taskId === undefined
      ? 0
      : props.approvals.filter(
          (approval) => approval.status === 'pending' && approval.taskId === item.taskId,
        ).length

  /* 历史只算“有内容”的会话：空线程（迁移前点“新会话”留下的）不算历史，也不占位置。 */
  const filteredThreads = (): ChatThreadSummary[] => {
    const needle = query().toLowerCase()
    return threads().filter(
      (item) =>
        item.messageCount > 0 &&
        `${item.title} ${item.lastMessage ?? ''}`.toLowerCase().includes(needle),
    )
  }

  /**
   * 按工作区分组：同一个目录的会话归在一起。
   * 组的顺序就是该组里最近一条会话的顺序（`filteredThreads` 已按更新时间倒序），
   * 不另算一次排序，避免两个来源对不上。
   */
  const threadGroups = (): Array<{ path: string; items: ChatThreadSummary[] }> => {
    const groups = new Map<string, ChatThreadSummary[]>()
    for (const item of filteredThreads()) {
      const key = item.worktree ?? ''
      const existing = groups.get(key)
      if (existing === undefined) groups.set(key, [item])
      else existing.push(item)
    }
    return [...groups.entries()].map(([path, items]) => ({ path, items }))
  }

  const contextTask = (): TaskRow | undefined => {
    const id = thread()?.taskId
    return id === undefined ? undefined : props.tasks.find((task) => task.id === id)
  }

  const loadTaskDetail = (taskId: string): void => {
    taskRequestSeq += 1
    const seq = taskRequestSeq
    setTaskDetailError('')
    void api
      .task(taskId)
      .then((view) => {
        if (seq === taskRequestSeq) setTaskDetail(view)
      })
      .catch((cause) => {
        if (seq === taskRequestSeq) {
          setTaskDetailError(cause instanceof Error ? cause.message : String(cause))
        }
      })
  }

  /* 右侧栏 = 本次会话的资源：关联任务、改动文件、验收与待审批。 */
  createEffect(
    () => ({ taskId: thread()?.taskId, status: thread()?.status }),
    (value) => {
      if (value.taskId !== lastResourceTask) {
        lastResourceTask = value.taskId
        setTaskDetail(undefined)
      }
      if (value.taskId === undefined) return
      /* 任务状态变化（执行完成/等待）时重取：文件与验收都在结束后才出现。 */
      loadTaskDetail(value.taskId)
    },
  )

  const changedFiles = (): string[] => {
    const detail = taskDetail()
    if (detail === undefined) return []
    const files = new Set<string>()
    for (const execution of detail.executions) {
      for (const file of execution.evidence?.changedFiles ?? []) files.add(file)
    }
    return [...files]
  }

  const checks = (): { passed: number; total: number } => {
    const detail = taskDetail()
    if (detail === undefined) return { passed: 0, total: 0 }
    const all = detail.verifications.flatMap((run) => run.checks)
    return { passed: all.filter((check) => check.passed).length, total: all.length }
  }

  const pendingApprovals = (): number =>
    (taskDetail()?.approvals ?? []).filter((approval) => approval.status === 'pending').length

  /* 右侧栏是阅读器：任务进度 / 文件内容，而不是一堆摘要。 */
  const [viewer, setViewer] = createSignal<
    { kind: 'overview' } | { kind: 'task' } | { kind: 'file'; path: string }
  >({ kind: 'overview' })
  const [fileView, setFileView] = createSignal<{
    path: string
    content: string
    truncated: boolean
    source: 'worktree' | 'project'
  }>()
  const [fileLoading, setFileLoading] = createSignal(false)
  const [fileError, setFileError] = createSignal('')

  const openTaskViewer = (): void => {
    setViewer({ kind: 'task' })
    setRightCollapsed(false)
    const taskId = thread()?.taskId
    if (taskId !== undefined && taskDetail() === undefined && taskDetailError() === '') {
      loadTaskDetail(taskId)
    }
  }

  const viewerFilePath = (): string => {
    const value = viewer()
    return value.kind === 'file' ? value.path : ''
  }

  const openFileViewer = (path: string): void => {
    const taskId = thread()?.taskId
    if (taskId === undefined) return
    setViewer({ kind: 'file', path })
    setRightCollapsed(false)
    setFileView(undefined)
    setFileError('')
    setFileLoading(true)
    void api
      .taskFile(taskId, path)
      .then((result) => setFileView(result.file))
      .catch((cause) => setFileError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setFileLoading(false))
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
    if (item.id === 'new') void startDraft()
    else if (item.id === 'context') setPane(!rightCollapsed())
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

  /* 旧数据里可能存在 status=active 但没有消息的空 thread：不能当成运行中。 */
  const active = (): boolean => thread()?.status === 'active' && messages().length > 0

  /* 旧数据里“新建后没发消息”的 thread 仍是 active；展示成空闲，和新建保持一致。 */
  const threadStatus = (): string => {
    const current = thread()
    if (current === undefined) return 'idle'
    return current.status === 'active' && messages().length === 0 ? 'idle' : current.status
  }

  /* Real elapsed time for the loading line: no fake progress, just the clock.
     必须显式停掉上一支 interval：切换 thread 时只依赖 effect 的 cleanup，
     旧 timer 会留下来叠加，读数就会“越跳越快”。 */
  let elapsedClock: ReturnType<typeof setInterval> | undefined
  const stopElapsedClock = (): void => {
    if (elapsedClock !== undefined) clearInterval(elapsedClock)
    elapsedClock = undefined
  }

  const startElapsedClock = (): void => {
    stopElapsedClock()
    const current = thread()
    if (!active() || current === undefined) {
      setThinkingMs(0)
      if (current !== undefined) writeCachedThread(current.id, { runStartedAt: undefined })
      return
    }
    const cached = readCachedThread(current.id)?.runStartedAt
    const started = cached ?? Date.now()
    if (cached === undefined) writeCachedThread(current.id, { runStartedAt: started })
    setThinkingMs(Date.now() - started)
    elapsedClock = setInterval(() => setThinkingMs(Date.now() - started), 250)
  }

  createEffect(
    () => ({ running: active(), threadId: thread()?.id }),
    () => startElapsedClock(),
  )

  /* 两栅格：正文 + 可选上下文栏。会话抽屉是浮层，不占列。 */
  const gridStyle = (): JSX.CSSProperties | undefined => {
    if (!wide()) return undefined
    const right = wideContext() && !rightCollapsed() ? rightWidth() : 0
    return { 'grid-template-columns': `minmax(0,1fr) ${right}px` }
  }

  const columnStyle = (index: 1 | 2): JSX.CSSProperties | undefined =>
    wide() ? { 'grid-column': String(index) } : undefined

  const startDrag = (event: PointerEvent): void => {
    if (!wide()) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = rightWidth()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX
      setRightWidth(clampWidth(startWidth - delta, RIGHT_MIN, RIGHT_MAX))
    }
    const stop = (): void => {
      target.releasePointerCapture?.(event.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
      target.removeEventListener('pointercancel', stop)
      localStorage.setItem('hubagent.chat.rightWidth', String(rightWidth()))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
    target.addEventListener('pointercancel', stop)
  }

  const nudge = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 48 : 16
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const grow = event.key === 'ArrowLeft'
    setRightWidth(clampWidth(rightWidth() + (grow ? step : -step), RIGHT_MIN, RIGHT_MAX))
  }

  type TurnView = {
    key: string
    user?: ChatMessage
    steps: ChatMessage[]
    final?: ChatMessage
  }

  /* 一次用户消息 = 一个回合：执行步骤收进同一条折叠头，回答放在它下面。
     这样不会再出现“过程卡 / 任务卡 / 授权卡 / 回答”各带一个身份的三角色观感。 */
  const turns = createMemo<TurnView[]>(() => {
    const list: TurnView[] = []
    for (const message of messages()) {
      if (message.role === 'system') continue
      if (message.role === 'user') {
        list.push({ key: message.id, user: message, steps: [] })
        continue
      }
      let turn = list.at(-1)
      if (turn === undefined) {
        turn = { key: message.id, steps: [] }
        list.push(turn)
      }
      turn.steps.push(message)
    }
    for (const turn of list) {
      const last = turn.steps.at(-1)
      if (last !== undefined && (last.kind === 'text' || last.kind === 'result')) {
        turn.final = last
        turn.steps.pop()
      }
    }
    return list
  })

  /* 渲染窗口：DOM 里只保留最近 N 个回合。
     历史仍按 100 条一页从服务端拉（「加载更早」），但“已经拉下来”的长度没有上限；
     不设窗口的话 1000 条要一次性建 1000 个行组件（实测最长任务 ~1s），
     而屏幕上一次只看得到三四个回合。多出来的仍留在内存里，点一下就能展开。 */
  const RENDER_TURNS = 200
  const [renderLimit, setRenderLimit] = createSignal(RENDER_TURNS)
  const visibleTurns = createMemo<TurnView[]>(() => turns().slice(-renderLimit()))
  const hiddenTurns = (): number => Math.max(0, turns().length - renderLimit())

  const lastTurnKey = (): string | undefined => turns().at(-1)?.key

  const turnElapsed = (turn: TurnView): number => {
    /* 运行中的回合跟着计时器走，别让标题停在“0秒”。 */
    if (turn.final === undefined && active()) return Math.max(1_000, thinkingMs())
    const start = Date.parse(turn.user?.createdAt ?? turn.steps[0]?.createdAt ?? '')
    const lastStep = turn.steps.at(-1)?.createdAt
    const end = Date.parse(turn.final?.createdAt ?? lastStep ?? '')
    if (!Number.isFinite(start)) return 1_000
    return Math.max(1_000, (Number.isFinite(end) ? end : Date.now()) - start)
  }

  /* ---- dock：「现在怎么了」 ---- */
  /* 默认按状态：在跑/等你展开，跑完收起。用户手动改过就记住（按 thread）。 */
  const [dockOverride, setDockOverride] = createSignal<'open' | 'closed' | undefined>()
  const [dockThread, setDockThread] = createSignal<string | undefined>()

  const dockApprovals = (): ReturnType<typeof deriveAttention> => {
    const taskId = thread()?.taskId
    if (taskId === undefined) return []
    return deriveAttention({ approvals: props.approvals, tasks: props.tasks }).filter(
      (item) => item.taskId === taskId,
    )
  }

  const dockPhase = (): RunPhase => {
    if (dockApprovals().length > 0) return 'waiting'
    if (active()) return 'running'
    const status = threadStatus()
    if (status === 'failed' || status === 'error') return 'failed'
    if (status === 'waiting_approval' || status === 'waiting_input' || status === 'waiting') {
      return 'waiting'
    }
    return 'done'
  }

  /* 一个 Agent 一行：只认带 agentName 的过程步；派单句里的子任务标题作为“在做什么”。 */
  const dockAgents = (): DockAgent[] => {
    const turn = turns().at(-1)
    if (turn === undefined) return []
    const byAgent = new Map<string, DockAgent>()
    for (const step of turn.steps) {
      const name = step.agentName
      if (name === undefined || name === '') continue
      const previous = byAgent.get(name)
      const fromDispatch =
        step.stage === 'dispatching' || step.stage === 'retrying'
          ? (step.content.split('：').at(-1) ?? '')
          : undefined
      const status =
        step.stage === 'completed' ? 'done' : step.stage === 'failed' ? 'failed' : 'running'
      byAgent.set(name, {
        name,
        label: fromDispatch ?? previous?.label ?? '',
        status,
      })
    }
    return [...byAgent.values()]
  }

  const dockVisible = (): boolean =>
    thread() !== undefined && (turns().length > 0 || dockApprovals().length > 0)

  const dockOpen = (): boolean => {
    const override = dockOverride()
    if (override !== undefined && dockThread() === thread()?.id) return override === 'open'
    const phase = dockPhase()
    return phase === 'running' || phase === 'waiting'
  }

  const toggleDock = (): void => {
    setDockThread(thread()?.id)
    setDockOverride(dockOpen() ? 'closed' : 'open')
  }

  const handleAuthRetried = (result: { thread: ChatThread; messages: ChatMessage[] }): void => {
    setThread(result.thread)
    setMessages(result.messages)
    stick = true
    queueMicrotask(scrollToBottom)
    if (result.thread.status === 'active') watch(result.thread.id)
    else stopWatching()
    void loadThreads()
  }

  /* No credentials: the panes would all be empty, which reads as "broken"
     rather than "not connected yet". Show the reason and the one action
     instead, and keep the shell's own token banner quiet (see AppLayout). */
  if (getToken() === '') {
    return (
      <div class="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div class="flex max-w-[360px] flex-col items-center gap-3 text-center">
          <span class="grid size-12 place-items-center rounded-full bg-subtle text-ink-3">
            <Icon name="key" size={22} />
          </span>
          <h2 class="text-section text-ink">{props.t('daemonOfflineTitle')}</h2>
          <p class="text-meta text-ink-2">{props.t('daemonOfflineHint')}</p>
          <code class="mt-1 rounded-control bg-subtle px-3 py-1.5 font-mono text-meta text-ink-2">
            pnpm ha web
          </code>
        </div>
      </div>
    )
  }

  return (
    <div class="grid min-h-0 flex-1 max-[860px]:grid-cols-1" style={gridStyle()}>
      {/* 会话历史是抽屉（E 稿）：280px 面板从左侧伸出，遮罩可点关闭。 */}
      <Show when={drawerOpen()}>
        <div
          class="fixed inset-0 z-40 bg-ink/20"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
        <div
          class="hx-drawer fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[88vw] flex-col border-r border-line bg-canvas"
          role="dialog"
          aria-label={props.t('openThreads')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDrawerOpen(false)
          }}
        >
          <div class="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
            <h2 class="flex-1 text-meta font-semibold text-ink">{props.t('openThreads')}</h2>
            <IconButton
              icon="x"
              label={props.t('closeDrawer')}
              onClick={() => setDrawerOpen(false)}
            />
          </div>
          <div class="flex flex-none items-center gap-1.5 px-3 pb-2">
            {/* 新建在搜索框左边：先选目录，不建会话（见 startDraft）。 */}
            <IconButton
              icon="plus"
              label={props.t('newThread')}
              onClick={() => void startDraft()}
            />
            <input
              ref={(el) => {
                searchEl = el
              }}
              class="h-8 min-w-0 flex-1 rounded-control border border-line bg-surface px-2.5 text-meta text-ink placeholder:text-ink-3 focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
              type="search"
              aria-label={props.t('searchThreads')}
              placeholder={props.t('searchThreads')}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div
            class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
            onScroll={() => {
              if (menuFor() !== undefined) setMenuFor(undefined)
            }}
          >
            <For each={threadGroups()}>
              {(group) => (
                <>
                  <div class="px-2.5 pt-2 pb-1 text-badge font-medium text-ink-3">
                    <span class="block truncate" title={group.path === '' ? undefined : group.path}>
                      {group.path === '' ? props.t('noWorkspaceLabel') : shortPath(group.path)}
                    </span>
                  </div>
                  <For each={group.items}>
                    {(item) => (
                      <div
                        class={`group relative rounded-panel ${
                          thread()?.id === item.id ? 'bg-active' : 'hover:bg-hover'
                        }`}
                      >
                        <Show
                          when={renamingId() === item.id}
                          fallback={
                            <button
                              type="button"
                              class="flex w-full min-w-0 flex-col gap-[3px] px-2.5 py-2 pr-9 text-left"
                              onClick={() => {
                                setDrawerOpen(false)
                                props.onOpenThread(item.id)
                              }}
                              title={item.title}
                            >
                              <span
                                class={`truncate text-meta text-ink ${
                                  thread()?.id === item.id ? 'font-semibold' : 'font-medium'
                                }`}
                              >
                                {displayTitle(item.title)}
                              </span>
                              <span class="flex min-w-0 items-center gap-1.5 text-badge text-ink-3">
                                <span
                                  class={`inline-block size-1.5 flex-none rounded-full ${threadDot(item.status)}`}
                                  aria-hidden="true"
                                />
                                <span class="shrink-0 capitalize">{statusLabel(item.status)}</span>
                                <Show when={threadWaiting(item) > 0}>
                                  <span aria-hidden="true">·</span>
                                  <span class="shrink-0 font-semibold text-warning">
                                    {props.t('threadNeedYou', { count: threadWaiting(item) })}
                                  </span>
                                </Show>
                                <span aria-hidden="true">·</span>
                                <span class="truncate">
                                  {relativeTime(props.locale, item.updatedAt)}
                                </span>
                              </span>
                            </button>
                          }
                        >
                          <div class="px-2.5 py-2.5">
                            <input
                              class="h-7 w-full rounded-control border border-line bg-surface px-2 text-meta text-ink focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-ring"
                              value={renameDraft()}
                              aria-label={props.t('rename')}
                              ref={(element) =>
                                queueMicrotask(() => {
                                  element.focus()
                                  element.select()
                                })
                              }
                              onInput={(event) => setRenameDraft(event.currentTarget.value)}
                              onBlur={() => void commitRename(item.id)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void commitRename(item.id)
                                } else if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setRenamingId(undefined)
                                }
                              }}
                            />
                          </div>
                        </Show>

                        <Show when={renamingId() !== item.id}>
                          <button
                            type="button"
                            class={`absolute top-1 right-1 grid size-7 place-items-center rounded-control text-ink-3 transition-opacity hover:bg-subtle hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring ${
                              menuFor() === item.id
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100'
                            }`}
                            aria-label={props.t('threadActions')}
                            title={props.t('threadActions')}
                            onClick={(event) => {
                              event.stopPropagation()
                              if (menuFor() === item.id) {
                                setMenuFor(undefined)
                                return
                              }
                              const rect = event.currentTarget.getBoundingClientRect()
                              const width = 128
                              const height = 108
                              const top =
                                rect.bottom + 4 + height > window.innerHeight
                                  ? Math.max(8, rect.top - height - 4)
                                  : rect.bottom + 4
                              setMenuPos({ left: Math.max(8, rect.right - width), top })
                              setMenuFor(item.id)
                            }}
                          >
                            <Icon name="more" size={15} />
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={filteredThreads().length === 0}>
              <div class={emptyBlock}>
                <span class={emptyGlyph}>
                  <Icon name="message" size={18} />
                </span>
                <span>{props.t('noThreads')}</span>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      <section
        class="flex min-h-0 min-w-0 flex-col bg-canvas"
        aria-label={props.t('chat')}
        style={columnStyle(1)}
      >
        {/* 头部（v9）：标题 + chevron 是抽屉入口；副行只说“在哪个工作区 · 什么权限”。
            右侧只有一个“⋯”文本菜单——v9 的头部不放图标按钮。 */}
        <header class="flex-none px-5 pt-[18px] pb-3.5">
          <div class="mx-auto flex w-full max-w-[720px] items-start gap-2.5">
            <div class="min-w-0 flex-1">
              <button
                type="button"
                class="-ml-0.5 inline-flex max-w-full items-center gap-[7px] rounded-control border border-transparent py-px pr-1.5 pl-0.5 text-left text-[17px] leading-[1.35] font-semibold text-ink transition-colors hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-haspopup="dialog"
                aria-expanded={drawerOpen() ? 'true' : 'false'}
                aria-label={props.t('openThreads')}
                onClick={() => setDrawerOpen(true)}
              >
                <span class="truncate">
                  {thread() === undefined ? props.t('chat') : displayTitle(thread()?.title ?? '')}
                </span>
                <Icon name="chevronDown" size={14} class="shrink-0 text-ink-3" />
              </button>
              <div class="mt-[5px] flex min-w-0 items-center gap-2 text-badge text-ink-3">
                <Show when={currentWorkspace() !== ''}>
                  <span class="truncate font-mono" title={currentWorkspace()}>
                    {shortPath(currentWorkspace())}
                  </span>
                  <span aria-hidden="true">·</span>
                </Show>
                <span class="shrink-0">
                  {props.t(permissionKey(thread()?.permissionMode ?? permissionMode()))}
                </span>
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-control px-1.5 py-1 text-meta leading-none text-ink-3 transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label={props.t('threadActions')}
              aria-haspopup="menu"
              onClick={(event) => {
                const item = thread()
                if (item === undefined) return
                const rect = event.currentTarget.getBoundingClientRect()
                const width = 128
                const height = 108
                const top =
                  rect.bottom + 4 + height > window.innerHeight
                    ? Math.max(8, rect.top - height - 4)
                    : rect.bottom + 4
                setMenuPos({ left: Math.max(8, rect.right - width), top })
                setMenuFor(menuFor() === item.id ? undefined : item.id)
              }}
            >
              ⋯
            </button>
          </div>
        </header>

        <Show when={error() !== ''}>
          <div class="flex-none bg-danger-soft px-5 py-2 text-badge text-danger" role="alert">
            {error()}
          </div>
        </Show>

        <div
          class="hx-fade-bottom flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-1 pb-7"
          role="log"
          aria-live="polite"
          ref={(el) => {
            messagesEl = el
          }}
          onScroll={() => {
            stick = isNearBottom()
            const current = thread()
            if (current !== undefined && messagesEl !== undefined) {
              writeCachedThread(current.id, { scrollTop: messagesEl.scrollTop })
            }
          }}
        >
          {/* Reading measure, matching MessageRow's width so the transcript and
              the composer line up instead of the composer running full-bleed. */}
          <div class="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-[22px]">
            <Show
              when={thread() !== undefined && messages().length > 0}
              fallback={
                <div class={centeredEmpty}>
                  <div class="flex w-full max-w-[46ch] flex-col gap-1.5">
                    <For each={starterPrompts}>
                      {(key) => (
                        <button
                          type="button"
                          class="w-full rounded-panel bg-subtle px-3.5 py-2.5 text-left text-meta text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          onClick={() => {
                            setText(props.t(key))
                            composerEl?.focus()
                          }}
                        >
                          {props.t(key)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              }
            >
              {/* 已经拉下来但被渲染窗口挡住的：先展开，不必再请求一次。 */}
              <Show when={hiddenTurns() > 0}>
                <div class="flex justify-center pb-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRenderLimit((current) => current + RENDER_TURNS)}
                  >
                    {props.t('showOlderTurns', { count: hiddenTurns() })}
                  </Button>
                </div>
              </Show>
              <Show when={hasMore()}>
                <div class="flex justify-center pb-1">
                  <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
                    {props.t('loadOlder')}
                  </Button>
                </div>
              </Show>
              <For each={visibleTurns()}>
                {(turn) => (
                  /* 长历史里只有看得到的那几回合需要参与布局/绘制（motion.css 的
                     hx-virtual-row = content-visibility:auto）：10k 条一次铺开会把首屏
                     拖到几十秒。高度用 auto 记住上一次的大小，避免滚动时跳。 */
                  <div class="hx-virtual-row">
                    <Show when={turn.user}>
                      {(user) => (
                        <MessageRow
                          message={user()}
                          t={props.t}
                          locale={props.locale}
                          streaming={false}
                          showMeta
                          threadId={thread()?.id}
                          onOpenTask={props.onOpenTask}
                          onApprove={(id) => void decideApproval(id, 'approve')}
                          onReject={(id) => void decideApproval(id, 'reject')}
                          onAnswer={(id, answer) => void answerClarification(id, answer)}
                          onAuthRetried={handleAuthRetried}
                        />
                      )}
                    </Show>
                    <Show
                      when={turn.steps.length > 0}
                      fallback={
                        <Show when={turn.final}>
                          {(final) => (
                            <MessageRow
                              message={final()}
                              t={props.t}
                              locale={props.locale}
                              streaming={active() && lastTurnKey() === turn.key}
                              showMeta
                              threadId={thread()?.id}
                              onOpenTask={props.onOpenTask}
                              onApprove={(id) => void decideApproval(id, 'approve')}
                              onReject={(id) => void decideApproval(id, 'reject')}
                              onAnswer={(id, answer) => void answerClarification(id, answer)}
                              onAuthRetried={handleAuthRetried}
                            />
                          )}
                        </Show>
                      }
                    >
                      <TurnBlock
                        turn={turn}
                        t={props.t}
                        locale={props.locale}
                        phase={
                          /* 有审批在等 → 这个回合不是“在跑”，是“等你”：
                             过程流随之收起，不让它把判断现场顶下去。 */
                          lastTurnKey() === turn.key && dockApprovals().length > 0
                            ? 'waiting'
                            : active() && lastTurnKey() === turn.key
                              ? 'running'
                              : threadStatus() === 'failed'
                                ? 'failed'
                                : threadStatus() === 'waiting'
                                  ? 'waiting'
                                  : 'done'
                        }
                        elapsedMs={turnElapsed(turn)}
                        streaming={active() && lastTurnKey() === turn.key}
                        threadId={thread()?.id}
                        task={contextTask()}
                        files={changedFiles()}
                        onOpenTask={openTaskViewer}
                        onOpenFile={openFileViewer}
                        onApprove={(id) => void decideApproval(id, 'approve')}
                        onReject={(id) => void decideApproval(id, 'reject')}
                        onAnswer={(id, answer) => void answerClarification(id, answer)}
                        onAuthRetried={handleAuthRetried}
                      />
                    </Show>
                  </div>
                )}
              </For>
              <Show when={active() && (turns().at(-1)?.steps.length ?? 0) === 0}>
                <LoadingState label={props.t('loading')} elapsedMs={thinkingMs()} />
              </Show>
            </Show>
          </div>
        </div>

        {/* No top border: the transcript and the composer read as one surface
            instead of two stacked panels. */}
        {/* dock 回答“现在怎么了”：谁在跑、卡在哪；对话回答“发生过什么”。 */}
        <Show when={dockVisible()}>
          <div class="flex-none px-5 pt-3 pb-2">
            <RunDock
              phase={dockPhase()}
              agents={dockAgents()}
              approvals={dockApprovals()}
              elapsedMs={thinkingMs()}
              open={dockOpen()}
              onToggle={toggleDock}
              onApprove={(id) => void decideApproval(id, 'approve')}
              onReject={(id) => void decideApproval(id, 'reject')}
              t={props.t}
            />
          </div>
        </Show>
        <form
          class="flex-none px-5 pb-[18px]"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          {/* 与正文同一量度（v9：720px），输入面不会横跨整个面板。 */}
          <div class="mx-auto flex w-full max-w-[720px] flex-col">
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
            {/* 工作区不在输入框里选：新建走抽屉的「+」，已建会话用它自己的 worktree。 */}
            {/* 一个输入壳（v9）：textarea + 控件行同属一块，不再分成三行。 */}
            <div class="rounded-[16px] border border-line-strong bg-raised px-3 pt-3 pb-[9px] shadow-[0_1px_2px_rgb(18_21_26/5%),0_12px_28px_-14px_rgb(18_21_26/18%)] transition-[border-color,box-shadow] focus-within:border-[color-mix(in_oklab,var(--hx-accent)_45%,var(--hx-line-default))]">
              <textarea
                id="chat-composer"
                rows="2"
                ref={(el) => {
                  composerEl = el
                }}
                class="block max-h-[200px] min-h-12 w-full resize-none border-0 bg-transparent px-1 py-0.5 text-body leading-[1.5] text-ink placeholder:text-ink-3 focus-visible:outline-none"
                value={text()}
                placeholder={props.t('chatPlaceholder')}
                onInput={(event) => {
                  const value = event.currentTarget.value
                  setText(value)
                  const current = thread()
                  if (current === undefined) writeUnsavedDraft(value)
                  else writeCachedThread(current.id, { draft: value })
                }}
                onKeyDown={submitOnEnter}
              />
              <div class="flex items-center gap-1.5 pt-2">
                {/* 权限：无边框的下拉（v9 控件行的降噪）。原生 select 保留语义与键盘。 */}
                <label
                  class="relative inline-flex h-6 items-center gap-[5px] text-badge font-medium text-ink-3 transition-colors hover:text-ink focus-within:text-ink"
                  title={props.t('workspace')}
                >
                  <Icon name="shield" size={12} class="shrink-0" />
                  <select
                    id="chat-permission"
                    class="cursor-pointer appearance-none border-0 bg-transparent pr-4 text-badge font-medium text-ink-3 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    value={thread()?.permissionMode ?? permissionMode()}
                    disabled={active()}
                    onChange={(event) => {
                      const next = event.currentTarget.value as PermissionMode
                      setPermissionMode(next)
                      writePermissionMode(next)
                      const current = thread()
                      if (current !== undefined) {
                        void chatApi
                          .setPermission(current.id, next)
                          .then(() => loadThreads())
                          .catch((cause: unknown) =>
                            setError(cause instanceof Error ? cause.message : String(cause)),
                          )
                      }
                    }}
                  >
                    <option value="read-only">{props.t('permissionReadOnly')}</option>
                    <option value="workspace-write">{props.t('permissionWorkspaceWrite')}</option>
                    <option value="full">{props.t('permissionFull')}</option>
                  </select>
                  <Icon
                    name="chevronDown"
                    size={11}
                    class="pointer-events-none absolute right-0 shrink-0"
                  />
                </label>
                {/* 运行设置：只给图标（ADR 0029 §2.4）。
                    非默认时带一个小圆点，否则没人记得自己改过。 */}
                <button
                  type="button"
                  class="relative inline-flex size-6 items-center justify-center text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-45"
                  title={props.t('runSettings')}
                  aria-label={props.t('runSettings')}
                  disabled={thread() === undefined}
                  onClick={() => setRunSettingsOpen(true)}
                >
                  <Icon name="settings" size={13} />
                  <Show when={runSettingsDirty()}>
                    <span
                      class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-ink-2"
                      aria-hidden="true"
                      title={props.t('runSettingsCustom')}
                    />
                  </Show>
                </button>
                <span class="flex-1" />
                <span class="hidden items-center gap-[5px] text-badge text-ink-3 min-[560px]:inline-flex">
                  <kbd class="rounded border border-line px-1 text-[10px] leading-4">⏎</kbd>
                  {props.t('sendHint')}
                  <kbd class="ml-1 rounded border border-line px-1 text-[10px] leading-4">⇧⏎</kbd>
                  {props.t('newlineHint')}
                </span>
                <button
                  type="submit"
                  class="grid size-[30px] flex-none place-items-center rounded-full bg-ink text-canvas transition-transform duration-160 ease-[var(--ease-out)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.94] disabled:bg-line-strong disabled:text-ink-3 disabled:hover:opacity-100"
                  aria-label={props.t('send')}
                  title={props.t('send')}
                  disabled={busy() || active() || text().trim() === '' || picking()}
                >
                  <Icon name="arrowUp" size={15} />
                </button>
              </div>
            </div>
          </div>
        </form>

        <RunSettingsDialog
          open={runSettingsOpen()}
          onClose={() => setRunSettingsOpen(false)}
          settings={thread()?.runSettings ?? DEFAULT_RUN_SETTINGS}
          agents={props.agents}
          t={props.t}
          onSave={saveRunSettings}
        />
      </section>

      <aside
        class={`relative min-h-0 min-w-0 flex-col overflow-hidden border-l border-line bg-canvas max-[1100px]:hidden ${
          rightCollapsed() ? 'hidden' : 'flex'
        }`}
        aria-label={props.t('threadContext')}
        style={columnStyle(2)}
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <div class="mb-3 flex flex-col gap-1">
            <span class="text-meta font-semibold text-ink">{props.t('threadContext')}</span>
            <p class="text-badge leading-relaxed text-ink-3">{props.t('chatContextHint')}</p>
          </div>
          <Show when={thread()}>
            {(current) => (
              <>
                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-badge">
                  <dt class="text-ink-3">{props.t('status')}</dt>
                  <dd class="text-right">
                    <StatusBadge
                      status={threadStatus()}
                      label={props.t(statusKey(threadStatus()))}
                    />
                  </dd>
                  <dt class="text-ink-3">{props.t('messages')}</dt>
                  <dd class="text-right tabular-nums text-ink">{messages().length}</dd>
                  <dt class="text-ink-3">{props.t('goal')}</dt>
                  <dd
                    class="min-w-0 truncate text-right font-mono text-ink"
                    title={current().goalId ?? undefined}
                  >
                    {current().goalId === undefined ? '—' : shortenId(current().goalId ?? '')}
                  </dd>
                </dl>
                <Show
                  when={contextTask()}
                  fallback={
                    <p class="mt-4 text-badge leading-relaxed text-ink-3">
                      {current().taskId === undefined
                        ? props.t('chatNoTask')
                        : `${props.t('taskId')} ${shortenId(current().taskId ?? '')}`}
                    </p>
                  }
                >
                  {(task) => (
                    <a
                      class="mt-4 flex items-center justify-between gap-2 rounded-panel border border-line bg-surface px-3 py-2.5 text-meta text-ink transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      href={`/tasks/${task().id}`}
                    >
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="truncate">{task().title}</span>
                        <span class="text-badge text-ink-3">
                          {props.t(statusKey(task().status))}
                        </span>
                      </span>
                      <Icon name="external" size={13} />
                    </a>
                  )}
                </Show>

                <Show when={taskDetail()}>
                  <div class="mt-5 flex flex-col gap-3 border-t border-line pt-3.5">
                    <div>
                      <div class="flex items-center justify-between text-badge">
                        <span class="font-medium text-ink-3">{props.t('chatFiles')}</span>
                        <span class="tabular-nums text-ink-3">{changedFiles().length}</span>
                      </div>
                      <Show
                        when={changedFiles().length > 0}
                        fallback={
                          <p class="mt-1 text-badge leading-relaxed text-ink-3">
                            {props.t('chatNoFiles')}
                          </p>
                        }
                      >
                        <ul class="mt-1.5 flex flex-col gap-1">
                          <For each={changedFiles().slice(0, 12)}>
                            {(file) => (
                              <li
                                class="flex items-center gap-1.5 text-badge text-ink-2"
                                title={file}
                              >
                                <Icon name="file" size={12} class="shrink-0 text-ink-3" />
                                <span class="truncate font-mono">{file}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </div>
                    <div class="flex items-center justify-between text-badge">
                      <span class="text-ink-3">{props.t('chatVerification')}</span>
                      <span class="tabular-nums text-ink">
                        {checks().passed}/{checks().total}
                      </span>
                    </div>
                    <Show when={pendingApprovals() > 0}>
                      <a
                        class="flex items-center justify-between rounded-panel border border-line bg-surface px-3 py-2 text-badge text-ink transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        href="/approvals"
                      >
                        <span>
                          {props.t('chatPendingApprovals', { count: pendingApprovals() })}
                        </span>
                        <Icon name="external" size={12} />
                      </a>
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Show when={viewer().kind !== 'overview'}>
          <div class="absolute inset-0 z-20 flex flex-col bg-canvas">
            <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <button
                type="button"
                class="flex items-center gap-1 rounded-control px-1.5 py-1 text-badge text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => setViewer({ kind: 'overview' })}
              >
                <Icon name="arrowLeft" size={13} />
                {props.t('chatBack')}
              </button>
              <span class="min-w-0 flex-1 truncate text-meta font-medium text-ink">
                {viewer().kind === 'task' ? props.t('chatTaskView') : props.t('chatFileView')}
              </span>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
              <Show when={viewer().kind === 'task'}>
                <TaskViewerPanel
                  t={props.t}
                  task={contextTask()}
                  detail={taskDetail()}
                  error={taskDetailError()}
                  locale={props.locale}
                  onRetry={() => {
                    const taskId = thread()?.taskId
                    if (taskId !== undefined) loadTaskDetail(taskId)
                  }}
                />
              </Show>
              <Show when={viewer().kind === 'file'}>
                <FileViewerPanel
                  t={props.t}
                  path={viewerFilePath()}
                  loading={fileLoading()}
                  error={fileError()}
                  view={fileView()}
                />
              </Show>
            </div>
          </div>
        </Show>
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
            onPointerDown={(event) => startDrag(event)}
            onKeyDown={(event) => nudge(event)}
          />
        </Show>
      </aside>

      {/* 菜单用 fixed 定位渲染在滚动容器外：列表的 overflow 不会裁掉它。 */}
      <Show when={menuFor() !== undefined}>
        <div
          class="fixed inset-0 z-[60]"
          aria-hidden="true"
          onClick={() => setMenuFor(undefined)}
        />
        <div
          class="fixed z-[70] w-32 rounded-panel border border-line bg-surface p-1 shadow-popover"
          style={{ left: `${menuPos().left}px`, top: `${menuPos().top}px` }}
          role="menu"
          aria-label={props.t('threadActions')}
        >
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-meta text-ink hover:bg-hover"
            onClick={() => {
              const item = menuThread()
              if (item !== undefined) beginRename(item)
            }}
          >
            <Icon name="edit" size={13} />
            {props.t('rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-meta text-ink hover:bg-hover"
            onClick={() => {
              const item = menuThread()
              if (item !== undefined) void archiveThreadNow(item)
            }}
          >
            <Icon name="archive" size={13} />
            {props.t('archive')}
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-meta text-danger hover:bg-danger-soft"
            onClick={() => {
              const item = menuThread()
              setMenuFor(undefined)
              if (item !== undefined) setDeleting(item)
            }}
          >
            <Icon name="trash" size={13} />
            {props.t('delete')}
          </button>
        </div>
      </Show>

      <Dialog
        open={deleting() !== undefined}
        onClose={() => setDeleting(undefined)}
        title={props.t('deleteThreadTitle')}
        closeLabel={props.t('close')}
      >
        <p class="text-meta leading-relaxed text-ink-2">{props.t('deleteThreadBody')}</p>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(undefined)}>
            {props.t('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const item = deleting()
              if (item !== undefined) void removeThreadNow(item)
            }}
          >
            {props.t('delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

/* 时长文案必须跟着语言走：英文界面里出现“1秒”是漏翻（曾经真实发生过）。 */
function formatDuration(ms: number, t: Translator): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (total < 60) return t('durationSeconds', { seconds: total })
  if (minutes < 60) return t('durationMinutes', { minutes, seconds })
  return t('durationHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

function TurnBlock(props: {
  turn: { key: string; user?: ChatMessage; steps: ChatMessage[]; final?: ChatMessage }
  t: Translator
  locale: Locale
  phase: 'running' | 'failed' | 'waiting' | 'done'
  elapsedMs: number
  streaming: boolean
  threadId?: string
  task?: TaskRow
  files: string[]
  onOpenTask: () => void
  onOpenFile: (path: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer: (id: string, answer: string) => void
  onAuthRetried: (result: { thread: ChatThread; messages: ChatMessage[] }) => void
}) {
  /* 状态字样只在 dock；过程头只说“这一段是什么”。
     但授权/澄清是判断现场，不能被折叠藏住（v7 决定 O）。 */
  const open = (): boolean =>
    props.phase === 'running' ||
    props.phase === 'failed' ||
    props.turn.steps.some((step) => step.kind === 'auth' || step.kind === 'clarification')

  return (
    <article class="flex flex-col">
      <ProcessTrace
        title={props.t('chatProcess')}
        meta={`${props.turn.steps.length} ${props.t('chatSteps')} · ${props.t('chatTurnElapsed', {
          duration: formatDuration(props.elapsedMs, props.t),
        })}`}
        open={open()}
      >
        <ol class="flex list-none flex-col gap-1.5 p-0">
          <For each={props.turn.steps}>
            {(step) => (
              <TurnStep
                step={step}
                t={props.t}
                locale={props.locale}
                threadId={props.threadId}
                onOpenTask={props.onOpenTask}
                onApprove={props.onApprove}
                onReject={props.onReject}
                onAnswer={props.onAnswer}
                onAuthRetried={props.onAuthRetried}
              />
            )}
          </For>
        </ol>
      </ProcessTrace>

      <Show when={props.turn.final}>
        {(final) => (
          <div class="mt-2">
            <RichText
              text={final().content}
              copyLabel={props.t('copy')}
              streaming={props.streaming}
              quiet={final().kind === 'result'}
            />
          </div>
        )}
      </Show>

      <Show
        when={
          (props.phase === 'done' || props.phase === 'failed') &&
          (props.task !== undefined || props.files.length > 0)
        }
      >
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Show when={props.task}>
            {(task) => (
              <button
                type="button"
                class="flex max-w-[18rem] items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-badge text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                title={task().id}
                onClick={() => props.onOpenTask()}
              >
                <Icon name="tasks" size={12} class="shrink-0 text-ink-3" />
                <span class="truncate">{task().title}</span>
                <span class="shrink-0 text-ink-3">{props.t(statusKey(task().status))}</span>
              </button>
            )}
          </Show>
          <For each={props.files.slice(0, 6)}>
            {(file) => (
              <button
                type="button"
                class="flex max-w-[15rem] items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 font-mono text-badge text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                title={file}
                onClick={() => props.onOpenFile(file)}
              >
                <Icon name="file" size={12} class="shrink-0 text-ink-3" />
                <span class="truncate">{file.split('/').at(-1)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </article>
  )
}

function StepText(props: { text: string; t: Translator }) {
  const [open, setOpen] = createSignal(false)
  const long = (): boolean => props.text.length > 180 || props.text.split('\n').length > 2
  return (
    <>
      <p class={`whitespace-pre-wrap ${!open() && long() ? 'line-clamp-2' : ''}`}>{props.text}</p>
      <Show when={long()}>
        <button
          type="button"
          class="mt-1 text-badge text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          onClick={() => setOpen(!open())}
        >
          {open() ? props.t('chatCollapse') : props.t('chatExpand')}
        </button>
      </Show>
    </>
  )
}

function TurnStep(props: {
  step: ChatMessage
  t: Translator
  locale: Locale
  threadId?: string
  onOpenTask: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer: (id: string, answer: string) => void
  onAuthRetried: (result: { thread: ChatThread; messages: ChatMessage[] }) => void
}) {
  const step = props.step

  if (step.kind === 'progress' && step.stage === 'tool') {
    const detail = (): { command?: string; path?: string; output?: string } | undefined => {
      if (step.detail === undefined) return undefined
      try {
        return JSON.parse(step.detail) as { command?: string; path?: string; output?: string }
      } catch {
        return undefined
      }
    }
    return (
      <li>
        <Show
          when={step.detail !== undefined}
          fallback={
            <div class="flex items-start gap-2">
              <span class="mt-[2px] grid size-[18px] shrink-0 place-items-center text-ink-3">
                <Icon name="tool" size={12} />
              </span>
              <span class="min-w-0 break-words text-ink">{step.content}</span>
            </div>
          }
        >
          <details class="group/tool">
            {/* 悬停时同一 18px 槽位里图标交叉淡入为箭头；展开后箭头转 90°（v8）。 */}
            <summary class="flex cursor-pointer list-none items-start gap-2 text-ink [&::-webkit-details-marker]:hidden">
              <span class="relative mt-[2px] grid size-[18px] shrink-0 place-items-center text-ink-3">
                <Icon
                  name="tool"
                  size={12}
                  class="transition-opacity group-hover/tool:opacity-0 group-open/tool:opacity-0"
                />
                <Icon
                  name="chevronRight"
                  size={11}
                  class="absolute opacity-0 transition-all group-hover/tool:opacity-100 group-open/tool:rotate-90 group-open/tool:opacity-100"
                />
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-badge text-ink">
                {step.content}
              </span>
            </summary>
            <div class="mt-1.5 ml-[26px] flex flex-col gap-1.5 rounded-control bg-subtle p-2">
              <Show when={detail()?.command}>
                {(command) => (
                  <pre class="overflow-x-auto font-mono text-badge text-ink-2">$ {command()}</pre>
                )}
              </Show>
              <Show when={detail()?.path}>
                {(path) => <p class="font-mono text-badge text-ink-3">{path()}</p>}
              </Show>
              <Show when={detail()?.output}>
                {(output) => (
                  <pre class="max-h-64 overflow-auto rounded-control bg-canvas p-2 font-mono text-badge text-ink-2">
                    {output()}
                  </pre>
                )}
              </Show>
            </div>
          </details>
        </Show>
      </li>
    )
  }

  if (step.kind === 'progress') {
    /* 行内不再追加“完成/失败”：后端文案本身已经说了（`执行完成（验收 通过）`），
       状态由图标颜色承载，重复一遍反而像缺格的表格（v8 反馈）。 */
    return (
      <li class="flex items-start gap-2">
        <span class="mt-[2px] grid size-[18px] shrink-0 place-items-center">
          <Icon
            name={stepIcon(step.stage)}
            size={12}
            class={
              step.stage === 'failed'
                ? 'text-danger'
                : step.stage === 'completed'
                  ? 'text-success'
                  : step.stage === 'waiting'
                    ? 'text-warning'
                    : 'text-ink-3'
            }
          />
        </span>
        <div class="min-w-0 break-words text-ink">
          <Show
            when={step.stage === 'thought' || step.stage === 'output'}
            fallback={<span class="whitespace-pre-wrap">{step.content}</span>}
          >
            <StepText text={step.content} t={props.t} />
          </Show>
        </div>
      </li>
    )
  }

  if (step.kind === 'task') {
    return (
      <li class="flex items-center gap-2 text-meta text-ink-2">
        <Icon name="tasks" size={13} class="shrink-0 text-ink-3" />
        <span class="min-w-0 truncate">{props.t('chatTaskCreated')}</span>
        <button
          type="button"
          class="shrink-0 rounded-control border border-line px-2 py-0.5 text-badge text-ink hover:bg-hover"
          onClick={() => props.onOpenTask()}
        >
          {props.t('openTask')}
        </button>
      </li>
    )
  }

  if (step.kind === 'approval') {
    /* 审批是判断现场，但体积属于 dock（v9 §3.7.2）：对话里只留一条记录，
       不再同一件事说两遍。 */
    return (
      <li class="flex items-start gap-2 text-ink-2">
        <span class="mt-[2px] grid size-[18px] shrink-0 place-items-center">
          <Icon name="shield" size={12} class="text-warning" />
        </span>
        <span class="min-w-0 whitespace-pre-wrap">{step.content}</span>
      </li>
    )
  }

  if (step.kind === 'clarification' && step.clarificationId !== undefined) {
    return (
      <li>
        <ClarificationCard message={step} t={props.t} onAnswer={props.onAnswer} />
      </li>
    )
  }

  if (step.kind === 'auth') {
    return (
      <li>
        <AuthCard
          message={step}
          t={props.t}
          {...(props.threadId === undefined ? {} : { threadId: props.threadId })}
          onRetried={props.onAuthRetried}
        />
      </li>
    )
  }

  if (step.kind === 'error') {
    return (
      <li class="rounded-panel border border-line bg-danger-soft px-3.5 py-2.5">
        <div class="flex items-center gap-2 text-meta font-medium text-danger">
          <Icon name="alert" size={14} />
          <span>{props.t('statusFailed')}</span>
        </div>
        <p class="mt-1 break-words whitespace-pre-wrap text-meta text-danger">{step.content}</p>
      </li>
    )
  }

  return (
    <li class="text-ink-2">
      <RichText text={step.content} copyLabel={props.t('copy')} quiet />
    </li>
  )
}

function TaskViewerPanel(props: {
  t: Translator
  task?: TaskRow
  detail?: TaskView
  error: string
  locale: Locale
  onRetry: () => void
}) {
  return (
    <Show
      when={props.detail}
      fallback={
        <div class="flex flex-col gap-2">
          <p class={`text-badge ${props.error === '' ? 'text-ink-3' : 'text-danger'}`}>
            {props.error === '' ? props.t('chatFileLoading') : props.error}
          </p>
          <Show when={props.error !== ''}>
            <Button variant="secondary" size="sm" onClick={() => props.onRetry()}>
              {props.t('chatRetry')}
            </Button>
          </Show>
        </div>
      }
    >
      {(detail) => (
        <div class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-meta font-medium text-ink">
              {props.task?.title ?? detail().task.title}
            </span>
            <StatusBadge
              status={detail().task.status}
              label={props.t(statusKey(detail().task.status))}
            />
          </div>

          <section class="flex flex-col gap-1.5">
            <h3 class="text-badge font-medium text-ink-3">{props.t('chatSubtasks')}</h3>
            <ul class="flex flex-col gap-1">
              <For each={detail().subtasks}>
                {(subtask) => (
                  <li class="flex items-center justify-between gap-2 text-badge">
                    <span class="min-w-0 truncate text-ink-2">{subtask.title}</span>
                    <span class="shrink-0 text-ink-3">{props.t(statusKey(subtask.status))}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <section class="flex flex-col gap-1.5">
            <h3 class="text-badge font-medium text-ink-3">{props.t('chatExecutions')}</h3>
            <For each={detail().executions}>
              {(execution) => (
                <div class="rounded-panel border border-line bg-surface p-2.5 text-badge">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-mono text-ink-2">attempt {execution.attempt}</span>
                    <span class="text-ink-3">{props.t(statusKey(execution.status))}</span>
                  </div>
                  <Show when={(execution.evidence?.changedFiles?.length ?? 0) > 0}>
                    <ul class="mt-1.5 flex flex-col gap-0.5">
                      <For each={execution.evidence?.changedFiles ?? []}>
                        {(file) => (
                          <li class="truncate font-mono text-ink-3" title={file}>
                            {file}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              )}
            </For>
          </section>

          <section class="flex flex-col gap-1.5">
            <h3 class="text-badge font-medium text-ink-3">{props.t('chatChecks')}</h3>
            <For each={detail().verifications.flatMap((run) => run.checks)}>
              {(check) => (
                <div class="flex items-center gap-2 text-badge">
                  <Icon
                    name={check.passed ? 'check' : 'alert'}
                    size={12}
                    class={check.passed ? 'text-success' : 'text-danger'}
                  />
                  <span class="min-w-0 flex-1 truncate text-ink-2">
                    {check.command ?? check.kind}
                  </span>
                  <span class="shrink-0 text-ink-3">{check.exitCode ?? ''}</span>
                </div>
              )}
            </For>
          </section>
        </div>
      )}
    </Show>
  )
}

function FileViewerPanel(props: {
  t: Translator
  path: string
  loading: boolean
  error: string
  view?: { path: string; content: string; truncated: boolean; source: 'worktree' | 'project' }
}) {
  return (
    <div class="flex flex-col gap-2">
      <span class="break-all font-mono text-badge text-ink-3">{props.path}</span>
      <Show when={props.loading}>
        <p class="text-badge text-ink-3">{props.t('chatFileLoading')}</p>
      </Show>
      <Show when={props.error !== ''}>
        <p class="text-badge text-danger">{props.error}</p>
      </Show>
      <Show when={props.view}>
        {(view) => (
          <pre class="max-h-full overflow-auto rounded-panel border border-line bg-surface p-3 font-mono text-badge leading-relaxed text-ink">
            {view().content}
          </pre>
        )}
      </Show>
    </div>
  )
}

function MessageRow(props: {
  message: ChatMessage
  t: Translator
  locale: Locale
  /** Last message of a running thread: its tail is genuinely still arriving. */
  streaming: boolean
  /** 同一角色连续发言时只显示一次名字/时间。 */
  showMeta: boolean
  threadId?: string
  onOpenTask: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer: (id: string, answer: string) => void
  onAuthRetried: (result: { thread: ChatThread; messages: ChatMessage[] }) => void
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
      <article class="flex flex-col items-end">
        {/* 用户气泡（v2 §会话）：12px 圆角 + 1px 边框的 raised 块，没有小尾巴。
            v9 正文没有时间戳——时间在会话抽屉里，不在每一句旁边。 */}
        <div class="max-w-[min(70%,60ch)] rounded-panel border border-line bg-raised px-3 py-[9px] text-body text-ink">
          <RichText text={props.message.content} copyLabel={props.t('copy')} />
        </div>
      </article>
    )
  }

  const plan = (): boolean => props.message.kind === 'plan'
  const card = (): boolean =>
    props.message.kind === 'task' ||
    props.message.kind === 'approval' ||
    props.message.kind === 'clarification' ||
    props.message.kind === 'auth'

  /* agent 产出的文本是 `**标题**\n\n正文`（后端这么拼）：拆开画成 v9 的块。 */
  const agentParts = (): { title: string; body: string } | undefined => {
    if (props.message.agentName === undefined) return undefined
    const match = /^\*\*(.+?)\*\*\s*\n+([\s\S]*)$/.exec(props.message.content)
    return match === null ? undefined : { title: match[1] ?? '', body: match[2] ?? '' }
  }

  return (
    <article class={props.message.agentName === undefined ? 'flex flex-col' : 'flex gap-2.5'}>
      {/* v9：助手侧没有头像与“HubAgent · 时间”；只有 agent 产出带 18px 首字母徽标。 */}
      <Show when={props.message.agentName}>
        {(name) => (
          <span
            class="mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-ink text-[9px] font-semibold tracking-tight text-canvas"
            aria-hidden="true"
          >
            {agentBadge(name())}
          </span>
        )}
      </Show>
      <div class="min-w-0 flex-1">
        <Show when={chips().length > 0 && !card() && props.message.kind !== 'error'}>
          <ToolChips chips={chips()} class="mb-2" />
        </Show>

        <Show
          when={
            props.message.kind === 'clarification' && props.message.clarificationId !== undefined
          }
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
              <Button
                variant="ghost"
                onClick={() => props.onReject(props.message.approvalId ?? '')}
              >
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

        <Show when={props.message.kind === 'auth'}>
          <AuthCard
            message={props.message}
            t={props.t}
            {...(props.threadId === undefined ? {} : { threadId: props.threadId })}
            onRetried={props.onAuthRetried}
          />
        </Show>

        <Show when={props.message.kind === 'error'}>
          <div class="rounded-panel border border-line bg-danger-soft px-3.5 py-2.5">
            <div class="flex items-center gap-2 text-meta font-medium text-danger">
              <Icon name="alert" size={14} />
              <span>{props.t('statusFailed')}</span>
            </div>
            <p class="mt-1 break-words whitespace-pre-wrap text-meta text-danger">
              {props.message.content}
            </p>
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

        <Show when={agentParts()}>
          {(parts) => (
            <div>
              <p class="text-meta font-semibold text-ink">{parts().title}</p>
              <div class="mt-1">
                <RichText
                  text={parts().body}
                  copyLabel={props.t('copy')}
                  streaming={props.streaming}
                />
              </div>
            </div>
          )}
        </Show>
        <Show when={agentParts() === undefined}>
          <Show
            when={
              !card() &&
              props.message.kind !== 'error' &&
              props.message.kind !== 'progress' &&
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
        </Show>
      </div>
    </article>
  )
}

const stepIcon = (stage: ChatMessage['stage']): IconName => {
  switch (stage) {
    case 'thinking':
      return 'activity'
    case 'tool':
      return 'tool'
    case 'thought':
      return 'message'
    case 'output':
      return 'terminal'
    case 'planned':
      return 'tasks'
    case 'dispatching':
      return 'plug'
    case 'waiting':
      return 'clock'
    case 'completed':
      return 'check'
    case 'failed':
      return 'alert'
    default:
      return 'activity'
  }
}

function ProgressTrace(props: {
  steps: ChatMessage[]
  t: Translator
  locale: Locale
  open: boolean
}) {
  const last = (): string => props.steps.at(-1)?.content ?? ''
  return (
    <article class="flex gap-2.5">
      <div class="mt-[3px] grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-ink-3">
        <Icon name="activity" size={12} />
      </div>
      <div class="min-w-0 flex-1">
        <ThinkingTrace
          title={props.t('chatProcess')}
          meta={`${props.steps.length} ${props.t('chatSteps')}`}
          summary={last()}
          open={props.open}
        >
          <ol class="flex flex-col gap-1.5">
            <For each={props.steps}>
              {(step) => (
                <li class="flex items-start gap-2">
                  <Icon
                    name={stepIcon(step.stage)}
                    size={12}
                    class={`mt-[3px] shrink-0 ${
                      step.stage === 'failed'
                        ? 'text-danger'
                        : step.stage === 'completed'
                          ? 'text-success'
                          : 'text-ink-3'
                    }`}
                  />
                  <span class="shrink-0 font-mono text-badge text-ink-3">
                    {relativeTime(props.locale, step.createdAt)}
                  </span>
                  <span
                    class={`min-w-0 break-words whitespace-pre-wrap ${
                      step.stage === 'thought' || step.stage === 'output'
                        ? 'text-ink-2'
                        : 'text-ink'
                    }`}
                  >
                    {step.content}
                  </span>
                </li>
              )}
            </For>
          </ol>
        </ThinkingTrace>
      </div>
    </article>
  )
}

const probeFlights = new Map<string, Promise<ProbeResultView>>()

/** 同一 Agent 的探测在前端也单飞：多张授权卡不互相撞锁。 */
function verifyOnce(name: string): Promise<ProbeResultView> {
  const existing = probeFlights.get(name)
  if (existing !== undefined) return existing
  const promise = api
    .verifyAgent(name)
    .then((result) => result.probe)
    .finally(() => probeFlights.delete(name))
  probeFlights.set(name, promise)
  return promise
}

function AuthCard(props: {
  message: ChatMessage
  t: Translator
  threadId?: string
  onRetried: (result: { thread: ChatThread; messages: ChatMessage[] }) => void
}) {
  const [probe, setProbe] = createSignal<ProbeResultView>()
  const [agents, setAgents] = createSignal<AgentRow[]>([])
  const [checking, setChecking] = createSignal(false)
  const [busy, setBusy] = createSignal('')
  const [error, setError] = createSignal('')
  const [notice, setNotice] = createSignal('')
  let retriedCheck = false
  const name = (): string => props.message.agentName ?? ''
  const methods = (): AuthMethodView[] => probe()?.authMethods ?? []
  const alternatives = (): AgentRow[] =>
    agents()
      .filter(
        (agent) =>
          agent.name !== name() &&
          agent.status !== 'offline' &&
          agent.status !== 'disabled' &&
          agent.status !== 'error',
      )
      .slice(0, 3)

  const check = async (): Promise<void> => {
    if (name() === '') return
    setChecking(true)
    setError('')
    setNotice('')
    try {
      setProbe(await verifyOnce(name()))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      /* 探测单飞被占用不是失败：中性提示 + 稍后自动再试一次。 */
      if (/正在验证|稍后重试/.test(message)) {
        setNotice(props.t('chatAuthChecking'))
        if (!retriedCheck) {
          retriedCheck = true
          setTimeout(() => void check(), 1_500)
        }
      } else {
        setError(message)
      }
    } finally {
      setChecking(false)
    }
  }

  const resumeRun = async (agentName?: string): Promise<void> => {
    if (props.threadId === undefined || busy() !== '') return
    setBusy(agentName ?? 'resume')
    setError('')
    try {
      props.onRetried(await chatApi.resume(props.threadId, agentName))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const login = async (methodId: string): Promise<void> => {
    if (name() === '' || busy() !== '') return
    setBusy(methodId)
    setError('')
    try {
      const result = await api.loginAgent(name(), methodId)
      if (!result.ok) {
        setError(result.result.error?.message ?? props.t('chatAuthFailed'))
        return
      }
      await resumeRun()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  /* 只读 Agent 列表，不触发探测；检测交给用户点「重新检测」。 */
  onSettled(() => {
    void api
      .agents()
      .then((result) => setAgents(result.agents))
      .catch(() => undefined)
  })

  return (
    <div class="rounded-panel border border-line bg-canvas p-3">
      <div class="flex items-center gap-2 text-meta font-medium text-warning">
        <Icon name="key" size={14} />
        <span>{props.t('chatAuthTitle')}</span>
      </div>
      <p class="mt-1.5 text-meta text-ink-2">
        {name() === '' ? props.t('chatAuthHint') : props.t('chatAuthHintAgent', { agent: name() })}
      </p>
      <details class="mt-1.5">
        <summary class="cursor-pointer text-badge text-ink-3">{props.t('chatAuthDetail')}</summary>
        <p class="mt-1 break-words whitespace-pre-wrap font-mono text-badge text-ink-3">
          {props.message.content}
        </p>
      </details>
      <Show when={methods().length > 0}>
        <div class="mt-2.5 flex flex-wrap gap-2">
          <For each={methods()}>
            {(method) => (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy() !== '' || method.type === 'terminal'}
                title={
                  method.type === 'terminal'
                    ? props.t('chatAuthTerminal')
                    : (method.description ?? '')
                }
                onClick={() => void login(method.id)}
              >
                {busy() === method.id ? props.t('chatAuthWorking') : (method.name ?? method.id)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={methods().length === 0 && !checking()}>
        <p class="mt-2 text-badge text-ink-3">{props.t('chatAuthManual')}</p>
      </Show>
      <Show when={probe()?.status === 'online'}>
        <div class="mt-2.5">
          <Button size="sm" disabled={busy() !== ''} onClick={() => void resumeRun()}>
            {busy() === 'resume' ? props.t('chatAuthWorking') : props.t('chatAuthContinue')}
          </Button>
        </div>
      </Show>
      <Show when={alternatives().length > 0}>
        <p class="mt-2.5 text-badge text-ink-3">{props.t('chatAuthSwitch')}</p>
        <div class="mt-1.5 flex flex-wrap gap-2">
          <For each={alternatives()}>
            {(agent) => (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy() !== ''}
                onClick={() => void resumeRun(agent.name)}
              >
                {busy() === agent.name ? props.t('chatAuthWorking') : agent.name}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={notice() !== ''}>
        <p class="mt-2 text-badge text-ink-3">{notice()}</p>
      </Show>
      <Show when={error() !== ''}>
        <p class="mt-2 text-badge text-danger">{error()}</p>
      </Show>
      <div class="mt-2.5 flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={checking()} onClick={() => void check()}>
          {checking() ? props.t('chatAuthWorking') : props.t('chatAuthProbe')}
        </Button>
        <a
          class="text-badge text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          href="/registry"
        >
          {props.t('chatAuthOpenAgents')}
        </a>
      </div>
    </div>
  )
}

function ClarificationCard(props: {
  message: ChatMessage
  t: Translator
  onAnswer: (id: string, answer: string) => void
}) {
  const [value, setValue] = createSignal('')
  const [detail, setDetail] = createSignal<ClarificationView>()

  /* 选项在 clarifications 表里，消息只带 id：卡片自己取一次，
     这样刷新后已作答的卡片也能显示当时的选项和答案。 */
  onSettled(() => {
    const id = props.message.clarificationId
    if (id === undefined) return
    void chatApi
      .clarification(id)
      .then((result) => setDetail(result.clarification))
      .catch(() => undefined)
  })

  const options = (): string[] => detail()?.options ?? []
  const pending = (): boolean => detail() === undefined || detail()?.status === 'pending'
  const submit = (answer: string): void => {
    const text = answer.trim()
    if (text === '' || !pending()) return
    props.onAnswer(props.message.clarificationId ?? '', text)
  }

  return (
    <div class="mt-2 rounded-panel border border-line bg-canvas p-3">
      <div class="flex items-center gap-2 text-meta font-medium text-ink">
        <Icon name="message" size={14} />
        <span>{props.t('clarification')}</span>
      </div>
      <p class="mt-1.5 text-meta text-ink-2">{props.message.content}</p>
      <Show
        when={pending()}
        fallback={
          <p class="mt-2 flex items-center gap-1.5 text-badge text-ink-3">
            <Icon name="check" size={12} />
            <span>{props.t('answered')}</span>
            <Show when={detail()?.answer !== undefined}>
              <span class="text-ink-2">{detail()?.answer}</span>
            </Show>
          </p>
        }
      >
        <Show
          when={options().length > 0}
          fallback={
            <form
              class="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                submit(value())
              }}
            >
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
            </form>
          }
        >
          <div class="mt-2 flex flex-wrap gap-2">
            <For each={options()}>
              {(option) => (
                <Button variant="secondary" size="sm" onClick={() => submit(option)}>
                  {option}
                </Button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
