import { useLocation, useNavigate } from '@solidjs/router'
import { dynamic, type JSX } from '@solidjs/web'
import { createEffect, createSignal, For, onFlush, onSettled, Show } from 'solid-js'
import type { CommandPaletteProps, PaletteGroup } from '../components/ui/CommandPalette'
import { Icon, type IconName } from '../components/ui/Icon'
import { ConnectionDot } from '../components/ui/StatusBadge'
import { Toaster } from '../components/ui/Toaster'
import { InboxPanel } from '../features/inbox/InboxPanel'
import { deriveAttention } from '../shared/attention'
import { formatRelativeTime } from '../shared/i18n'
import { useApp } from './store'

/* The palette drags the SDK's command + dialog + popup foundation (~180 kB) into
   whatever chunk imports it, so it only loads once someone presses ⌘K. */
const LazyCommandPalette = dynamic(() =>
  import('../components/ui/CommandPalette').then((module) => module.CommandPalette),
) as unknown as (props: CommandPaletteProps) => JSX.Element

/* 两个目的地 + 设置（ADR 0029 §2.2）。任务与审批仍是对象/深链，不占导航位：
   它们是“某个东西”，不是“某个地方”。 */
const NAV: ReadonlyArray<{ href: string; key: 'navChat' | 'navAgents' }> = [
  { href: '/chat', key: 'navChat' },
  { href: '/agents', key: 'navAgents' },
]

/* 页签是纯文字（v2 `.tab`）：图标在这两个目的地上是噪点。30px 高、13px。 */
const navTab =
  'inline-flex h-[30px] items-center rounded-control px-2.5 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const navTabIdle = 'font-medium text-ink-3 hover:text-ink'
const navTabActive = 'bg-raised font-semibold text-ink'

/* 移动端底部条带图标（顶部页签不带）：手机上图标是快速识别，文字是可用性。 */
const BOTTOM_ICONS: Record<'navChat' | 'navAgents', IconName> = {
  navChat: 'message',
  navAgents: 'agents',
}

const bottomTab =
  'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-badge transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'

const bodyPane = 'flex min-h-0 flex-1 flex-col overflow-hidden'
const bodyScroll = 'min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 max-[1100px]:px-4'

export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const path = () => location.pathname
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteLoaded, setPaletteLoaded] = createSignal(false)
  const [inboxOpen, setInboxOpen] = createSignal(false)

  const isChat = (): boolean => path() === '/' || path().startsWith('/chat')
  const isTasks = (): boolean => path().startsWith('/tasks')
  /* 运行详情页自己有一个 h1（任务标题）；顶栏再排一个 h1 就会出现两个一级标题，
     读屏目录也会重复。这里只降为普通文本标签。 */
  const isTaskDetail = (): boolean => isTasks() && path().length > '/tasks'.length
  /* Agent 是一个目的地、两个分段（现场 / 接入）：分段控件在页面里（AgentsPage），
     顶栏只按深链页的规矩显示页名。 */
  const isAgentsSection = (): boolean =>
    path().startsWith('/agents') || path().startsWith('/registry')

  const title = (): string => {
    if (isAgentsSection()) return app.t('agents')
    if (path().startsWith('/approvals')) return app.t('approvals')
    if (path().startsWith('/settings')) return app.t('settings')
    if (isChat()) return app.t('chat')
    return app.t('tasks')
  }

  const isActive = (prefix: string): boolean =>
    prefix === '/tasks'
      ? path() === '/tasks' || path().startsWith('/tasks/')
      : prefix === '/agents'
        ? isAgentsSection()
        : path().startsWith(prefix)

  /* 注意力只有一个口径：审批 + 等你输入的任务，由 shared/attention 派生。 */
  const attentionItems = () => deriveAttention({ approvals: app.approvals(), tasks: app.tasks() })
  const attentionCount = (): number => attentionItems().length

  const connectionLabel = (): string => {
    const value = app.connection()
    if (value === 'live') return app.t('connected')
    if (value === 'connecting') return app.t('reconnecting')
    return app.t('offline')
  }

  /* 离线时必须诚实：数据是旧的，就说清楚有多旧。 */
  const connectionTitle = (): string => {
    const synced = app.lastSyncedAt()
    if (synced === undefined) return `${connectionLabel()} · ${app.t('never')}`
    const when = formatRelativeTime(app.locale(), synced)
    return `${connectionLabel()} · ${app.t('lastSynced', { time: when })}`
  }

  /* 浮层挂在 layout 上，路由不会把它卸载：跳转时必须自己关掉，
     否则点「所在任务」会后弹窗仍在任务页上方。 */
  createEffect(
    () => path(),
    () => {
      setInboxOpen(false)
      setPaletteOpen(false)
    },
  )

  /* Cmd/Ctrl+K anywhere in the console; the dialog owns Escape and focus return. */
  onSettled(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setPaletteLoaded(true)
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const paletteGroups = (): PaletteGroup[] => [
    {
      label: app.t('primaryNavigation'),
      items: [
        { value: 'nav:/chat', label: app.t('navChat') },
        { value: 'nav:/agents', label: app.t('navAgents') },
        { value: 'nav:/tasks', label: app.t('navTasks'), hint: app.t('navTasks') },
        { value: 'nav:/approvals', label: app.t('navApprovals') },
        { value: 'nav:/settings', label: app.t('navSettings') },
      ],
    },
    {
      label: app.t('paletteMore'),
      items: [
        { value: 'action:theme', label: app.t('theme'), hint: app.theme.theme() },
        {
          value: 'action:language',
          label: app.t('language'),
          hint: app.locale() === 'zh-CN' ? '中' : 'EN',
        },
        { value: 'action:refresh', label: app.t('refresh'), hint: '⌘R' },
      ],
    },
  ]

  const runPalette = (value: string): void => {
    onFlush(() => setPaletteOpen(false))
    if (value.startsWith('nav:')) {
      navigate(value.slice(4))
      return
    }
    if (value === 'action:theme') app.theme.cycleTheme()
    else if (value === 'action:language')
      app.setLocale(app.locale() === 'zh-CN' ? 'en-US' : 'zh-CN')
    else if (value === 'action:refresh') void app.refresh()
  }

  return (
    <div class="flex h-dvh min-h-0 flex-col">
      <Toaster />
      <Show when={paletteLoaded()}>
        <LazyCommandPalette
          open={paletteOpen()}
          onOpenChange={setPaletteOpen}
          title={app.t('command')}
          placeholder={app.t('palettePlaceholder')}
          empty={app.t('paletteEmpty')}
          groups={paletteGroups()}
          onRun={runPalette}
        />
      </Show>

      <InboxPanel
        open={inboxOpen()}
        items={attentionItems()}
        onClose={() => setInboxOpen(false)}
        onApprove={(id) => void app.decide(id, 'approve')}
        onReject={(id) => void app.decide(id, 'reject')}
        t={app.t}
      />

      {/* 顶栏（v2 `.bar`）：50px 高、1px 下边线；页签是纯文字，右侧只留注意力 + 连接 + 设置。 */}
      <header class="flex h-[50px] flex-none items-center gap-2.5 border-b border-line bg-canvas px-4 max-[860px]:h-12 max-[860px]:px-3">
        <a
          class="grid size-8 shrink-0 place-items-center rounded-control text-accent transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href="/chat"
          title={app.t('appName')}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
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
          <span class="visually-hidden">{app.t('appName')}</span>
        </a>

        {/* ≥861px：文本页签。≤860px 让位给底部条——只装两个目的地时，顶部页签是多余的。 */}
        <nav
          class="flex items-center gap-[2px] max-[860px]:hidden"
          aria-label={app.t('primaryNavigation')}
        >
          <For each={NAV}>
            {(item) => (
              <a
                href={item.href}
                class={`${navTab} ${isActive(item.href) ? navTabActive : navTabIdle}`}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {app.t(item.key)}
              </a>
            )}
          </For>
        </nav>

        {/* 深链页（任务/审批/设置）没有页内标题，所以页面名放在 app bar 上。
            Agent 页例外：目的地页签已经写着“Agent”，再排一个同名页名会被读成两个页签；
            现场/接入 由页面内的分段控件表达（AgentsPage）。 */}
        <Show
          when={!isChat() && !isAgentsSection()}
          fallback={<h1 class="visually-hidden">{title()}</h1>}
        >
          <Show
            when={!isTaskDetail()}
            fallback={
              <span class="min-w-0 truncate text-meta font-semibold text-ink">{title()}</span>
            }
          >
            <h1 class="min-w-0 truncate text-meta font-semibold text-ink">{title()}</h1>
          </Show>
        </Show>
        <span class="flex-1" />

        {/* 注意力（v2 `.attention`）：方块不是胶囊；“需要你”只在这里出现暖色。
            没有待办时它**不出现**——挂着一颗灰点写“需要你处理”是假信号。 */}
        <Show when={attentionCount() > 0}>
          <button
            type="button"
            class="inline-flex h-[30px] items-center gap-2 rounded-control border border-[color-mix(in_oklab,var(--hx-accent)_38%,transparent)] bg-accent-soft px-2.5 text-meta font-semibold text-accent transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={app.t('attentionCount', { count: attentionCount() })}
            aria-haspopup="dialog"
            aria-expanded={inboxOpen() ? 'true' : 'false'}
            title={app.t('attentionHint')}
            onClick={() => setInboxOpen(true)}
          >
            <span
              class="inline-block size-[7px] flex-none rounded-full bg-accent"
              aria-hidden="true"
            />
            <span class="tabular-nums max-[560px]:hidden">
              {app.t('attentionCount', { count: attentionCount() })}
            </span>
            <span class="text-badge font-normal text-ink-2 max-[860px]:hidden">
              {app.t('attentionDetail', { count: attentionCount() })}
            </span>
            <span class="tabular-nums min-[561px]:hidden">{attentionCount()}</span>
          </button>
        </Show>

        {/* 连接：点 + 文字（v2 `.conn`），不做胶囊——它不是控件，是状态。 */}
        <span
          class="inline-flex items-center gap-1.5 whitespace-nowrap text-badge text-ink-3"
          title={connectionTitle()}
        >
          <ConnectionDot state={app.connection()} />
          <span class="max-[860px]:hidden">{connectionLabel()}</span>
        </span>

        <a
          href="/settings"
          class={`grid size-[30px] place-items-center rounded-control transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-[860px]:hidden ${
            isActive('/settings') ? 'text-ink' : 'text-ink-3'
          }`}
          aria-current={isActive('/settings') ? 'page' : undefined}
          aria-label={app.t('navSettings')}
          title={app.t('navSettings')}
        >
          <Icon name="settings" size={16} />
        </a>
      </header>

      <main class="flex min-h-0 min-w-0 flex-1 flex-col max-[860px]:pb-[calc(52px+env(safe-area-inset-bottom))]">
        <Show when={app.error() !== ''}>
          <div
            class="mx-4 mb-3 flex flex-none items-center justify-between gap-3 rounded-panel bg-danger-soft px-3 py-2.5 text-meta text-danger"
            role="alert"
          >
            <span class="flex items-center gap-2">
              <span class="shrink-0">
                <Icon name="alert" size={15} />
              </span>
              <span>
                {app.t('errorPrefix')}: {app.error()}
              </span>
            </span>
          </div>
        </Show>

        {/* 页面没有拿到注入的 token，说明它不是 daemon 托管的：给出唯一可执行的动作，
            不提供手动填 token 的入口（token 由 daemon 注入，用户不该经手）。 */}
        <Show when={app.token() === '' && !isChat()}>
          <div
            class="mx-4 mb-3 flex flex-none items-center gap-3 rounded-panel border border-line bg-surface px-3 py-2"
            role="status"
          >
            <Icon name="key" size={16} class="shrink-0 text-ink-3" />
            <span class="min-w-0 flex-1 truncate text-meta text-ink-2">
              <strong class="font-semibold text-ink">{app.t('daemonOfflineTitle')}</strong>
              {' — '}
              {app.t('daemonOfflineHint')}
            </span>
          </div>
        </Show>

        <div class={isChat() || isTasks() || isAgentsSection() ? bodyPane : bodyScroll}>
          {props.children}
        </div>
      </main>

      {/* ≤860px：带文字标签的底部条。注意力控件留在 app bar，所以这里只有目的地。 */}
      <nav
        class="fixed inset-x-0 bottom-0 z-20 hidden h-[calc(52px+env(safe-area-inset-bottom))] items-stretch border-t border-line bg-canvas px-2 pb-[env(safe-area-inset-bottom)] max-[860px]:flex"
        aria-label={app.t('primaryNavigation')}
      >
        <For each={NAV}>
          {(item) => (
            <a
              href={item.href}
              class={`${bottomTab} ${
                isActive(item.href) ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
              aria-current={isActive(item.href) ? 'page' : undefined}
            >
              <Icon name={BOTTOM_ICONS[item.key]} size={18} />
              {app.t(item.key)}
            </a>
          )}
        </For>
        <a
          href="/settings"
          class={`${bottomTab} ${isActive('/settings') ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          aria-current={isActive('/settings') ? 'page' : undefined}
        >
          <Icon name="settings" size={18} />
          {app.t('navSettings')}
        </a>
      </nav>
    </div>
  )
}
