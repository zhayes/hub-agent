import { useLocation, useNavigate } from '@solidjs/router'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'
import { Icon } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { ConnectionDot } from '../components/ui/StatusBadge'
import { toast } from '../components/ui/Toaster'
import { draft } from '../features/chat/draft'
import { forgetThread, rememberWorkspace } from '../features/chat/store'
import { type ChatThreadSummary, chatApi } from '../shared/api'
import { relativeTime } from '../shared/format'
import type { Locale, Translator } from '../shared/i18n'
import { useApp } from './store'

/**
 * 左栏：工作区与会话。
 *
 * 这是“我在哪儿干活”的常驻面，不是抽屉：换会话是最高频的动作，藏起来就得多点一次。
 * 分成四段，从上到下依次是 新建 → 目的地（Agent 活动 / 等你处理）→ 会话（按目录归组）→ 设置。
 * 只有「等你处理」那一项允许出现强调色，其余全是灰阶。
 */
export interface SidebarProps {
  locale: Locale
  t: Translator
  attentionCount: number
  onOpenInbox: () => void
  /** 手机上是抽屉：点完一项就收起来。 */
  onNavigate?: () => void
}

const navRow =
  'flex h-[32px] w-full items-center gap-2.5 rounded-control px-2.5 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const navIdle = 'font-medium text-ink-2 hover:bg-hover hover:text-ink'
const navActive = 'bg-active font-semibold text-ink'

/** 组名只用末段目录名（`hub-agent`），完整路径放 title。 */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

export function Sidebar(props: SidebarProps) {
  const app = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal('')
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [menuFor, setMenuFor] = createSignal<string>()
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 })
  const [renamingId, setRenamingId] = createSignal<string>()
  const [renameDraft, setRenameDraft] = createSignal('')
  const [deleting, setDeleting] = createSignal<ChatThreadSummary>()
  const [picking, setPicking] = createSignal(false)
  let searchEl: HTMLInputElement | undefined

  const currentId = (): string | undefined => {
    const match = /^\/chat\/([^/]+)$/.exec(location.pathname)
    return match?.[1]
  }

  const isAgents = (): boolean =>
    location.pathname.startsWith('/agents') || location.pathname.startsWith('/registry')

  const go = (href: string): void => {
    navigate(href)
    props.onNavigate?.()
  }

  /* 历史只算“有内容”的会话：空线程（迁移前点“新会话”留下的）不算历史。 */
  const visible = createMemo<ChatThreadSummary[]>(() => {
    const needle = query().trim().toLowerCase()
    return app
      .threads()
      .filter(
        (item) =>
          item.messageCount > 0 &&
          (needle === '' ||
            `${item.title} ${item.lastMessage ?? ''}`.toLowerCase().includes(needle)),
      )
  })

  /**
   * 按工作区分组：同一个目录的会话归在一起。组顺序就是组内最近一条的顺序
   * （服务端已按更新时间倒序），不另算一次排序，避免两个来源对不上。
   */
  const groups = createMemo<Array<{ path: string; items: ChatThreadSummary[] }>>(() => {
    const map = new Map<string, ChatThreadSummary[]>()
    for (const item of visible()) {
      const key = item.worktree ?? ''
      const existing = map.get(key)
      if (existing === undefined) map.set(key, [item])
      else existing.push(item)
    }
    return [...map.entries()].map(([path, items]) => ({ path, items }))
  })

  /**
   * 新建工作区：系统目录框先选目录，再把请求交给对话页（见 features/chat/draft.ts）。
   * 这里不建线程——空会话不是会话，第一条消息才算。
   */
  const newWorkspace = async (): Promise<void> => {
    if (picking()) return
    setPicking(true)
    try {
      const result = await chatApi.pickDirectory()
      const path = result.path
      if (path === undefined || path === '') return
      rememberWorkspace(path)
      draft.begin(path)
      go('/chat')
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }

  const openSearch = (): void => {
    setSearchOpen(true)
    queueMicrotask(() => searchEl?.focus())
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
      await chatApi.rename(id, title)
      await app.refreshThreads()
      toast(props.t('threadRenamed'))
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const afterRemoval = async (id: string): Promise<void> => {
    forgetThread(id)
    await app.refreshThreads()
    if (currentId() === id) go('/chat')
  }

  const archive = async (item: ChatThreadSummary): Promise<void> => {
    setMenuFor(undefined)
    try {
      await chatApi.archive(item.id)
      await afterRemoval(item.id)
      toast(props.t('threadArchived'))
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const remove = async (item: ChatThreadSummary): Promise<void> => {
    setDeleting(undefined)
    try {
      await chatApi.remove(item.id)
      await afterRemoval(item.id)
      toast(props.t('threadDeleted'))
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const connectionLabel = (): string => {
    const value = app.connection()
    if (value === 'live') return props.t('connected')
    if (value === 'connecting') return props.t('reconnecting')
    return props.t('offline')
  }

  const connectionTitle = (): string => {
    const synced = app.lastSyncedAt()
    if (synced === undefined) return `${connectionLabel()} · ${props.t('never')}`
    return `${connectionLabel()} · ${props.t('lastSynced', { time: relativeTime(props.locale, synced) })}`
  }

  return (
    <aside
      class="flex h-full w-[268px] flex-none flex-col border-r border-line bg-canvas"
      aria-label={props.t('appName')}
    >
      <div class="flex h-[52px] flex-none items-center gap-2 px-3">
        <a
          class="grid size-7 shrink-0 place-items-center rounded-control text-accent transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href="/chat"
          title={props.t('appName')}
          onClick={() => props.onNavigate?.()}
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="2.7" />
            <circle cx="12" cy="4.2" r="1.7" />
            <circle cx="19" cy="17" r="1.7" />
            <circle cx="5" cy="17" r="1.7" />
            <path d="M12 6.6v2.7M14.3 13.7l3 2.2M9.7 13.7l-3 2.2" />
          </svg>
          <span class="visually-hidden">{props.t('appName')}</span>
        </a>
        <span class="min-w-0 flex-1 truncate text-meta font-semibold text-ink">
          {props.t('appName')}
        </span>
        <Show when={props.onNavigate !== undefined}>
          <IconButton icon="x" label={props.t('close')} onClick={() => props.onNavigate?.()} />
        </Show>
      </div>

      <div class="flex-none px-2.5 pb-2">
        <button
          type="button"
          class="flex h-[34px] w-full items-center gap-2 rounded-control border border-line bg-raised px-2.5 text-meta font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
          disabled={picking()}
          onClick={() => void newWorkspace()}
        >
          <Icon name="plus" size={15} class="shrink-0 text-ink-3" />
          <span class="truncate">{props.t('newWorkspace')}</span>
        </button>
      </div>

      <nav class="flex flex-none flex-col gap-px px-2" aria-label={props.t('primaryNavigation')}>
        <a
          href="/agents"
          class={`${navRow} ${isAgents() ? navActive : navIdle}`}
          aria-current={isAgents() ? 'page' : undefined}
          onClick={() => props.onNavigate?.()}
        >
          <Icon name="activity" size={15} class="shrink-0" />
          <span class="truncate">{props.t('agentStage')}</span>
        </a>
        <Show when={props.attentionCount > 0}>
          <button
            type="button"
            class={`${navRow} font-medium text-accent hover:bg-accent-soft`}
            aria-haspopup="dialog"
            aria-label={props.t('attentionCount', { count: props.attentionCount })}
            onClick={() => {
              props.onOpenInbox()
              props.onNavigate?.()
            }}
          >
            <span class="grid size-[15px] shrink-0 place-items-center" aria-hidden="true">
              <span class="size-[7px] rounded-full bg-accent" />
            </span>
            <span class="truncate">{props.t('inboxTitle')}</span>
            <span class="flex-1" />
            <span class="shrink-0 text-badge font-semibold tabular-nums">
              {props.attentionCount}
            </span>
          </button>
        </Show>
      </nav>

      <div class="mt-3 flex h-6 flex-none items-center gap-1 px-3">
        <span class="min-w-0 flex-1 truncate text-badge font-medium text-ink-3">
          {props.t('workspaces')}
        </span>
        <button
          type="button"
          class="grid size-6 place-items-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={props.t('searchWorkspaces')}
          aria-expanded={searchOpen() ? 'true' : 'false'}
          title={props.t('searchWorkspaces')}
          onClick={() => (searchOpen() ? setSearchOpen(false) : openSearch())}
        >
          <Icon name="search" size={13} />
        </button>
      </div>

      <Show when={searchOpen()}>
        <div class="flex-none px-2.5 pb-2">
          <input
            ref={(element) => {
              searchEl = element
            }}
            class="h-7 w-full rounded-control border border-line bg-surface px-2 text-meta text-ink placeholder:text-ink-3 focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
            type="search"
            aria-label={props.t('searchWorkspaces')}
            placeholder={props.t('searchWorkspaces')}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setQuery('')
                setSearchOpen(false)
              }
            }}
          />
        </div>
      </Show>

      <div
        class="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={() => {
          if (menuFor() !== undefined) setMenuFor(undefined)
        }}
      >
        <For each={groups()}>
          {(group) => (
            <>
              <div class="flex items-center gap-1.5 px-2 pt-2.5 pb-1">
                <Icon name="folder" size={12} class="shrink-0 text-ink-3" />
                <span
                  class="min-w-0 truncate text-badge font-medium text-ink-3"
                  title={group.path === '' ? undefined : group.path}
                >
                  {group.path === '' ? props.t('noWorkspaceLabel') : folderName(group.path)}
                </span>
              </div>
              <For each={group.items}>
                {(item) => (
                  <div
                    class={`group relative rounded-control ${
                      currentId() === item.id ? 'bg-active' : 'hover:bg-hover'
                    }`}
                  >
                    <Show
                      when={renamingId() === item.id}
                      fallback={
                        <button
                          type="button"
                          class="flex w-full min-w-0 items-center gap-1.5 rounded-control px-2 py-[5px] pr-8 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                          onClick={() => go(`/chat/${item.id}`)}
                          aria-current={currentId() === item.id ? 'page' : undefined}
                          title={item.title}
                        >
                          <Show when={needsYou(item)}>
                            <span
                              class="size-1.5 shrink-0 rounded-full bg-accent"
                              aria-hidden="true"
                            />
                            <span class="visually-hidden">
                              {props.t('threadNeedYou', { count: 1 })}
                            </span>
                          </Show>
                          <span
                            class={`min-w-0 flex-1 truncate text-meta ${
                              currentId() === item.id
                                ? 'font-semibold text-ink'
                                : 'font-medium text-ink-2'
                            }`}
                          >
                            {item.title}
                          </span>
                          <span
                            class={`shrink-0 text-badge group-hover:opacity-0 ${
                              currentId() === item.id ? 'text-ink-2' : 'text-ink-3'
                            }`}
                          >
                            {relativeTime(props.locale, item.updatedAt)}
                          </span>
                        </button>
                      }
                    >
                      <div class="px-2 py-1.5">
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
                        class={`absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-control text-ink-3 transition-opacity hover:bg-subtle hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring ${
                          menuFor() === item.id
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
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
                        <Icon name="more" size={14} />
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </>
          )}
        </For>

        <Show when={visible().length === 0}>
          <p class="px-2 py-3 text-badge leading-relaxed text-ink-3">{props.t('noThreads')}</p>
        </Show>
      </div>

      <div class="flex flex-none flex-col gap-1 border-t border-line px-2 py-2">
        <span
          class="flex items-center gap-1.5 px-2.5 text-badge text-ink-3"
          title={connectionTitle()}
        >
          <ConnectionDot state={app.connection()} />
          <span class="truncate">{connectionLabel()}</span>
        </span>
        <a
          href="/settings"
          class={`${navRow} ${location.pathname.startsWith('/settings') ? navActive : navIdle}`}
          aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
          onClick={() => props.onNavigate?.()}
        >
          <Icon name="settings" size={15} class="shrink-0" />
          <span class="truncate">{props.t('navSettings')}</span>
        </a>
      </div>

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
              const item = app.threads().find((entry) => entry.id === menuFor())
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
              const item = app.threads().find((entry) => entry.id === menuFor())
              if (item !== undefined) void archive(item)
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
              const item = app.threads().find((entry) => entry.id === menuFor())
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
              if (item !== undefined) void remove(item)
            }}
          >
            {props.t('delete')}
          </Button>
        </div>
      </Dialog>
    </aside>
  )
}

/** 这条会话是不是停在等人（澄清/审批）：侧栏只给这一个信号加点颜色。 */
function needsYou(item: ChatThreadSummary): boolean {
  return (
    item.status === 'waiting' ||
    item.status === 'waiting_input' ||
    item.status === 'waiting_approval'
  )
}
