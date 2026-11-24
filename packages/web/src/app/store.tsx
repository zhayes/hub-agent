import type { JSX } from '@solidjs/web'
import {
  type Accessor,
  createContext,
  createSignal,
  onCleanup,
  onSettled,
  useContext,
} from 'solid-js'
import {
  type AgentRow,
  type ApprovalRow,
  api,
  type Decision,
  getToken,
  saveToken,
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
  theme: ThemeController
  t: Translator
  refresh: () => Promise<void>
  openTask: (id: string, clearError?: boolean) => Promise<void>
  decide: (id: string, action: 'approve' | 'reject') => Promise<void>
  setLocale: (locale: Locale) => void
  saveConnectionToken: (value: string) => void
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
  const [token, setToken] = createSignal(getToken())
  const [locale, setLocaleSignal] = createSignal<Locale>(readLocale())
  const [connection, setConnection] = createSignal<Connection>('offline')
  const theme = createTheme()
  let source: EventSource | undefined

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

  const refresh = async (): Promise<void> => {
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
      const current = selected()
      const first = taskResult.tasks[0]
      if (current !== undefined) await openTask(current.task.id, false)
      else if (first !== undefined) await openTask(first.id, false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const decide = async (id: string, action: 'approve' | 'reject'): Promise<void> => {
    try {
      await (action === 'approve' ? api.approve(id) : api.reject(id))
      await refresh()
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
    })
    source.addEventListener('error', () => setConnection('connecting'))
  }

  const saveConnectionToken = (value: string): void => {
    const next = value.trim()
    saveToken(next)
    setToken(next)
    setError('')
    void refresh()
    connectEvents()
  }

  onSettled(() => {
    document.documentElement.lang = locale()
    if (token() !== '') {
      void refresh()
      connectEvents()
    }
  })
  onCleanup(() => source?.close())

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
    theme,
    t,
    refresh,
    openTask,
    decide,
    setLocale,
    saveConnectionToken,
  }

  return <AppContext value={value}>{props.children}</AppContext>
}

export function useApp(): AppStore {
  return useContext(AppContext)
}
