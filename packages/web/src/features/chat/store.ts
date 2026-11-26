import type { ChatMessage, ChatThread, ChatThreadSummary } from '../../shared/api'

/**
 * 对话页的会话内缓存。
 *
 * 路由切到 /tasks/:id 再回来时 ChatView 会重新挂载；没有这层缓存就只能先画空态
 * 再等一次网络往返。这里只缓存“已经看到过的东西”，服务端仍是唯一事实来源：
 * 挂载时先用缓存渲染，再后台刷新并按 id 合并。
 */
export interface CachedThread {
  thread?: ChatThread
  messages: ChatMessage[]
  hasMore: boolean
  /** SSE 的 rowid 游标，重连时从这里续传。 */
  seq?: number
  scrollTop?: number
  /** 未发送的草稿：切走再回来不该丢。 */
  draft?: string
  updatedAt: number
}

const threads = new Map<string, CachedThread>()
let cachedSummaries: ChatThreadSummary[] | undefined
/* 还没建 thread 时的草稿。 */
let unsavedDraft = ''

const LAST_THREAD_KEY = 'hubagent.chat.lastThread'

export function readCachedThread(id: string): CachedThread | undefined {
  return threads.get(id)
}

export function writeCachedThread(
  id: string,
  patch: Partial<Omit<CachedThread, 'updatedAt'>>,
): void {
  const current = threads.get(id) ?? { messages: [], hasMore: false, updatedAt: 0 }
  threads.set(id, { ...current, ...patch, updatedAt: Date.now() })
}

export function readCachedSummaries(): ChatThreadSummary[] | undefined {
  return cachedSummaries
}

export function writeCachedSummaries(list: ChatThreadSummary[]): void {
  cachedSummaries = list
}

export function readUnsavedDraft(): string {
  return unsavedDraft
}

export function writeUnsavedDraft(value: string): void {
  unsavedDraft = value
}

export function rememberThread(id: string): void {
  try {
    localStorage.setItem(LAST_THREAD_KEY, id)
  } catch {
    // 隐私模式禁用 localStorage 时只是失去“回到上次对话”，不影响使用。
  }
}

export function lastThread(): string | undefined {
  try {
    const value = localStorage.getItem(LAST_THREAD_KEY)
    return value === null || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

export function forgetThread(id: string): void {
  threads.delete(id)
  if (lastThread() === id) {
    try {
      localStorage.removeItem(LAST_THREAD_KEY)
    } catch {
      // 同上
    }
  }
}
