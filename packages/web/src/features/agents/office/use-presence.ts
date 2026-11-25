import { createSignal, onSettled } from 'solid-js'
import { type AgentPresenceResponse, api, getToken } from '../../../shared/api'

/**
 * presence 订阅（§3.3）：SSE 事件 → 250ms 去抖 refetch。
 *
 * - 不做本地状态推断，避免 UI 与 Runtime 漂移；数据只来自 GET /agents/presence。
 * - 断线重连后立即 refetch；`asOf` 由服务端返回，供 UI 判断陈旧。
 */

export type PresenceConnection = 'live' | 'connecting' | 'offline'

export interface PresenceStore {
  data: () => AgentPresenceResponse | undefined
  error: () => string
  connection: () => PresenceConnection
  refresh: () => void
}

/** 触发刷新的 SSE 事件类型（§3.3）。 */
const RELEVANT_EVENTS = new Set([
  'subtask.status',
  'execution.created',
  'execution.status',
  'approval.requested',
  'approval.decided',
  'verification.recorded',
])

export function createPresenceStore(): PresenceStore {
  const [data, setData] = createSignal<AgentPresenceResponse>()
  const [error, setError] = createSignal('')
  const [connection, setConnection] = createSignal<PresenceConnection>('offline')

  let source: EventSource | undefined
  let debounce: number | undefined
  let disposed = false

  const load = async (): Promise<void> => {
    try {
      const result = await api.presence()
      if (disposed) return
      setData(result)
      setError('')
    } catch (cause) {
      if (disposed) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const schedule = (): void => {
    if (debounce !== undefined) return
    debounce = window.setTimeout(() => {
      debounce = undefined
      void load()
    }, 250)
  }

  onSettled(() => {
    void load()
    const token = getToken()
    if (token === '') {
      setConnection('offline')
      return
    }
    setConnection('connecting')
    source = new EventSource(`/api/v1/events/stream?sinceSeq=0&token=${encodeURIComponent(token)}`)
    source.addEventListener('open', () => {
      setConnection('live')
      void load()
    })
    source.addEventListener('hubagent', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { type?: string }
        if (parsed.type !== undefined && RELEVANT_EVENTS.has(parsed.type)) schedule()
      } catch {
        schedule()
      }
    })
    source.addEventListener('error', () => setConnection('connecting'))

    return () => {
      disposed = true
      source?.close()
      if (debounce !== undefined) window.clearTimeout(debounce)
    }
  })

  return { data, error, connection, refresh: () => void load() }
}
