import { useLocation, useNavigate } from '@solidjs/router'
import { dynamic, type JSX } from '@solidjs/web'
import { createSignal, For, onFlush, onSettled, Show } from 'solid-js'
import type { CommandPaletteProps, PaletteGroup } from '../components/ui/CommandPalette'
import { Icon, type IconName } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { ConnectionDot } from '../components/ui/StatusBadge'
import { Toaster } from '../components/ui/Toaster'
import { useApp } from './store'

/* The palette drags the SDK's command + dialog + popup foundation (~180 kB) into
   whatever chunk imports it, so it only loads once someone presses ⌘K. */
const LazyCommandPalette = dynamic(() =>
  import('../components/ui/CommandPalette').then((module) => module.CommandPalette),
) as unknown as (props: CommandPaletteProps) => JSX.Element

const NAV: ReadonlyArray<{
  href: string
  key: 'navChat' | 'navTasks' | 'navAgents' | 'navRegistry' | 'navApprovals'
  icon: IconName
}> = [
  { href: '/chat', key: 'navChat', icon: 'message' },
  { href: '/tasks', key: 'navTasks', icon: 'tasks' },
  { href: '/agents', key: 'navAgents', icon: 'agents' },
  { href: '/registry', key: 'navRegistry', icon: 'plug' },
  { href: '/approvals', key: 'navApprovals', icon: 'approvals' },
]

/* Shell chrome on tokens. The body wrapper is plain utilities now: chat and
   tasks pin a full-height flex column, everything else scrolls. */
const railButton =
  'relative grid size-10 place-items-center rounded-panel transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:border forced-colors:border-CanvasText'

const bodyPane = 'flex min-h-0 flex-1 flex-col overflow-hidden'
const bodyScroll = 'min-h-0 flex-1 overflow-y-auto px-6 pb-7 max-[1100px]:px-4'
const railButtonIdle = 'text-ink-2 hover:bg-hover hover:text-ink'
const railButtonActive = 'bg-active text-ink'

export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const path = () => location.pathname
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteLoaded, setPaletteLoaded] = createSignal(false)

  const isChat = (): boolean => path() === '/' || path().startsWith('/chat')
  const isTasks = (): boolean => path().startsWith('/tasks')

  const title = (): string => {
    if (path().startsWith('/agents')) return app.t('agents')
    if (path().startsWith('/registry')) return app.t('registry')
    if (path().startsWith('/approvals')) return app.t('approvals')
    if (path().startsWith('/settings')) return app.t('settings')
    if (isChat()) return app.t('chat')
    return app.t('tasks')
  }

  const isActive = (prefix: string): boolean =>
    prefix === '/tasks'
      ? path() === '/tasks' || path().startsWith('/tasks/')
      : path().startsWith(prefix)

  const pendingApprovals = (): number =>
    app.approvals().filter((approval) => approval.status === 'pending').length
  const runningTasks = (): number => app.tasks().filter((task) => task.status === 'running').length
  const failedTasks = (): number => app.tasks().filter((task) => task.status === 'failed').length

  const note = (): string => {
    if (path().startsWith('/settings')) return ''
    if (path().startsWith('/registry')) return ''
    if (path().startsWith('/agents')) {
      if (app.agents().length === 0) return ''
      const noNetwork = app.agents().filter((agent) => agent.networkMode === 'deny').length
      const parts = [app.t('screenRegistered', { count: app.agents().length })]
      if (noNetwork > 0) parts.push(app.t('screenNoNetwork', { count: noNetwork }))
      return parts.join(' · ')
    }
    if (path().startsWith('/approvals')) {
      return pendingApprovals() === 0
        ? ''
        : app.t('screenWaitingOnYou', { count: pendingApprovals() })
    }
    const parts: string[] = []
    if (pendingApprovals() > 0) parts.push(app.t('screenApprovals', { count: pendingApprovals() }))
    if (runningTasks() > 0) parts.push(app.t('screenRunning', { count: runningTasks() }))
    if (failedTasks() > 0) parts.push(app.t('screenFailed', { count: failedTasks() }))
    /* No "nothing needs you" filler: an empty subtitle is quieter than a
       sentence that says nothing. */
    return parts.join(' · ')
  }

  const connectionLabel = (): string => {
    const value = app.connection()
    if (value === 'live') return app.t('connected')
    if (value === 'connecting') return app.t('reconnecting')
    return app.t('offline')
  }

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
        { value: 'nav:/tasks', label: app.t('navTasks') },
        { value: 'nav:/agents', label: app.t('navAgents') },
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
    <div class="grid h-dvh min-h-0 grid-cols-[56px_minmax(0,1fr)] max-[860px]:grid-cols-1">
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
      <aside
        class="flex min-h-0 flex-col items-center gap-1 border-r border-line bg-canvas pt-2.5 pb-3.5 max-[860px]:fixed max-[860px]:inset-x-0 max-[860px]:bottom-0 max-[860px]:z-20 max-[860px]:h-[calc(52px+env(safe-area-inset-bottom))] max-[860px]:flex-row max-[860px]:items-center max-[860px]:justify-between max-[860px]:border-r-0 max-[860px]:border-t max-[860px]:px-2.5 max-[860px]:pt-0 max-[860px]:pb-[env(safe-area-inset-bottom)]"
        aria-label={app.t('appName')}
      >
        <a
          class="mb-2 grid size-[38px] place-items-center rounded-panel text-accent transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-[860px]:hidden"
          href="/chat"
          title={app.t('appName')}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
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
        <nav
          class="flex flex-col items-center gap-0.5 max-[860px]:flex-row"
          aria-label={app.t('primaryNavigation')}
        >
          <For each={NAV}>
            {(item) => (
              <a
                href={item.href}
                class={`${railButton} ${isActive(item.href) ? railButtonActive : railButtonIdle}`}
                aria-current={isActive(item.href) ? 'page' : undefined}
                aria-label={
                  item.href === '/approvals' && pendingApprovals() > 0
                    ? `${app.t('navApprovals')} · ${app.t('pendingCount', { count: pendingApprovals() })}`
                    : app.t(item.key)
                }
                title={
                  item.href === '/approvals' && pendingApprovals() > 0
                    ? `${app.t('navApprovals')} · ${app.t('pendingCount', { count: pendingApprovals() })}`
                    : app.t(item.key)
                }
              >
                <Icon name={item.icon} size={18} />
                <Show when={item.href === '/approvals' && pendingApprovals() > 0}>
                  <span
                    class="absolute top-px right-px grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-badge font-semibold tabular-nums text-canvas"
                    aria-hidden="true"
                  >
                    {pendingApprovals()}
                  </span>
                </Show>
              </a>
            )}
          </For>
        </nav>
        {/* One entry point. Theme and language live in Settings, which already
            owns them; the rail stays a list of places, not a control panel. */}
        <div class="mt-auto flex w-10 flex-col items-center max-[860px]:mt-0 max-[860px]:w-auto max-[860px]:flex-row">
          <a
            href="/settings"
            class={`${railButton} ${isActive('/settings') ? railButtonActive : railButtonIdle}`}
            aria-current={isActive('/settings') ? 'page' : undefined}
            aria-label={app.t('navSettings')}
            title={app.t('navSettings')}
          >
            <Icon name="settings" size={18} />
          </a>
        </div>
      </aside>

      <main class="flex min-h-0 min-w-0 flex-col max-[860px]:pb-[calc(52px+env(safe-area-inset-bottom))]">
        <header class="flex h-12 flex-none items-center justify-between gap-4 border-b border-line px-6 max-[1100px]:px-4">
          <div class="flex min-w-0 items-baseline gap-2.5">
            <span class="text-meta font-semibold text-ink">{app.t('appName')}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span
              class="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-badge text-ink-2"
              title={app.t('eventsCount', { count: app.events().length })}
            >
              <ConnectionDot state={app.connection()} />
              <span>{connectionLabel()}</span>
            </span>
            <IconButton
              icon="refresh"
              label={app.t('refresh')}
              onClick={() => void app.refresh()}
            />
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex flex-none items-end justify-between gap-4 px-6 pt-[22px] pb-4 max-[1100px]:px-4 max-[860px]:items-start max-[860px]:pt-4 max-[860px]:pb-3 max-[560px]:pt-3.5 max-[560px]:pb-2.5">
            <div class="min-w-0">
              <h1 class="text-title text-ink">{title()}</h1>
              <Show when={note() !== ''}>
                <p class="mt-1.5 text-meta text-ink-2">{note()}</p>
              </Show>
            </div>
          </div>

          <Show when={app.error() !== ''}>
            <div
              class="mx-6 mb-3 flex flex-none items-center justify-between gap-3 rounded-panel bg-danger-soft px-3 py-2.5 text-meta text-danger max-[1100px]:mx-4"
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
              class="mx-6 mb-3 flex flex-none items-center gap-3 rounded-panel border border-line bg-surface px-3 py-2 max-[1100px]:mx-4"
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

          <div class={isChat() || isTasks() ? bodyPane : bodyScroll}>{props.children}</div>
        </div>
      </main>
    </div>
  )
}
