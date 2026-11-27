import type { JSX } from '@solidjs/web'
import {
  type Accessor,
  createContext,
  createSignal,
  onCleanup,
  onSettled,
  useContext,
} from 'solid-js'
import { toast } from '../components/ui/Toaster'
import {
  type AgentRow,
  type ApprovalRow,
  api,
  type Decision,
  getToken,
  type TaskRow,
  type TaskView,
} from '../shared/api'
import { detectLocale, isLocale, type Locale, type Translator, translate } from '../shared/i18n'
import { createTheme, type ThemeController } from '../shared/theme'

export type Connection = 'live' | 'connecting' | 'offline'

export interface AppStore {
  tasks: Accessor<TaskRow[]>
  agents: Accessor<AgentRow[]>
  approvals: Accessor<ApprovalRow[]>
  selected: Accessor<TaskView | undefined>
  decisions: Accessor<Decision[]>
  events: Accessor<string[]>
  error: Accessor<string>
  token: Accessor<string>
  locale: Accessor<Locale>
  connection: Accessor<Connection>
  /** 最后一次成功同步的时间；离线时要诚实地说数据有多旧。 */
  lastSyncedAt: Accessor<string | undefined>
  theme: ThemeController
  t: Translator
  refresh: () => Promise<void>
  openTask: (id: string, clearError?: boolean) => Promise<void>
  decide: (id: string, action: 'approve' | 'reject') => Promise<void>
  setLocale: (locale: Locale) => void
}

const LOCALE_KEY = 'hubagent.locale'
const AppContext = createContext<AppStore>()

function readLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // ignore blocked storage
  }
  return detectLocale(Array.from(navigator.languages ?? [navigator.language]))
}

export function AppProvider(props: { children: JSX.Element }) {
  const [tasks, setTasks] = createSignal<TaskRow[]>([])
  const [agents, setAgents] = createSignal<AgentRow[]>([])
  const [approvals, setApprovals] = createSignal<ApprovalRow[]>([])
  const [selected, setSelected] = createSignal<TaskView>()
  const [decisions, setDecisions] = createSignal<Decision[]>([])
  const [events, setEvents] = createSignal<string[]>([])
  const [error, setError] = createSignal('')
  const [token] = createSignal(getToken())
  const [locale, setLocaleSignal] = createSignal<Locale>(readLocale())
  const [connection, setConnection] = createSignal<Connection>('offline')
  const [lastSyncedAt, setLastSyncedAt] = createSignal<string>()
  const theme = createTheme()
  let source: EventSource | undefined
  let refreshTimer: number | undefined
  let refreshing: Promise<void> | undefined
  let refreshAgain = false

  const t: Translator = (key, params) => translate(locale(), key, params)

  const setLocale = (next: Locale): void => {
    setLocaleSignal(next)
    document.documentElement.lang = next
    try {
      localStorage.setItem(LOCALE_KEY, next)
    } catch {
      // ignore blocked storage
    }
  }

  const openTask = async (id: string, clearError = true): Promise<void> => {
    try {
      if (clearError) setError('')
      const [task, decision] = await Promise.all([api.task(id), api.decisions(id)])
      setSelected(task)
      setDecisions(decision.decisions)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadSnapshot = async (): Promise<void> => {
    if (getToken() === '') return
    try {
      setError('')
      const [taskResult, agentResult, approvalResult] = await Promise.all([
        api.tasks(),
        api.agents(),
        api.approvals(),
      ])
      setTasks(taskResult.tasks)
      setAgents(agentResult.agents)
      setApprovals(approvalResult.approvals)
      setLastSyncedAt(new Date().toISOString())
      /* 只刷新已经打开的那张详情：不再“列表一变就自动选中第一条”。
         自动选中会把“看一下任务页”变成“改了当前上下文”，是隐藏副作用。 */
      const current = selected()
      if (current !== undefined) await openTask(current.task.id, false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /* 单飞：事件来一串只跑一次；跑的过程中又来事件，就在结束后补跑一次。
     以前一条 SSE 事件触发一次全量重取，10 事件/秒就是 10 次风暴。 */
  const refresh = async (): Promise<void> => {
    if (refreshing !== undefined) {
      refreshAgain = true
      return refreshing
    }
    refreshing = loadSnapshot()
    try {
      await refreshing
    } finally {
      refreshing = undefined
      if (refreshAgain) {
        refreshAgain = false
        await refresh()
      }
    }
  }

  /* 尾随去抖：一串事件只在停下 350ms 后同步一次。 */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 350)
  }

  const decide = async (id: string, action: 'approve' | 'reject'): Promise<void> => {
    try {
      await (action === 'approve' ? api.approve(id) : api.reject(id))
      await refresh()
      /* The list re-renders without the row, so confirm the decision explicitly. */
      toast(t(action))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const connectEvents = (): void => {
    source?.close()
    const current = getToken()
    if (current === '') {
      setConnection('offline')
      return
    }
    setConnection('connecting')
    source = new EventSource(
      `/api/v1/events/stream?sinceSeq=0&token=${encodeURIComponent(current)}`,
    )
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('hubagent', (event) => {
      setEvents((previous) => [event.data, ...previous].slice(0, 30))
      scheduleRefresh()
    })
    source.addEventListener('error', () => setConnection('connecting'))
  }

  onSettled(() => {
    document.documentElement.lang = locale()
    if (token() !== '') {
      void refresh()
      connectEvents()
    }
  })
  onCleanup(() => {
    source?.close()
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  })

  const value: AppStore = {
    tasks,
    agents,
    approvals,
    selected,
    decisions,
    events,
    error,
    token,
    locale,
    connection,
    lastSyncedAt,
    theme,
    t,
    refresh,
    openTask,
    decide,
    setLocale,
  }

  return <AppContext value={value}>{props.children}</AppContext>
}

export function useApp(): AppStore {
  return useContext(AppContext)
}
