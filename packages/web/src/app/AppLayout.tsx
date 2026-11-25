import { useLocation, useNavigate } from '@solidjs/router'
import type { JSX } from '@solidjs/web'
import { createSignal, For, onFlush, onSettled, Show } from 'solid-js'
import { buttonPrimary } from '../components/ui/button-classes'
import { CommandPalette, type PaletteGroup } from '../components/ui/CommandPalette'
import { Icon, type IconName } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { Toaster } from '../components/ui/Toaster'
import { useApp } from './store'

const NAV: ReadonlyArray<{
  href: string
  key: 'navChat' | 'navTasks' | 'navAgents' | 'navApprovals'
  icon: IconName
}> = [
  { href: '/chat', key: 'navChat', icon: 'message' },
  { href: '/tasks', key: 'navTasks', icon: 'tasks' },
  { href: '/agents', key: 'navAgents', icon: 'agents' },
  { href: '/approvals', key: 'navApprovals', icon: 'approvals' },
]

/* Shell chrome on tokens. The scroll container (.screen-body + chat/scroll
   variants) stays legacy until P3 moves Tasks, because styles.css keys an
   override off `.screen-body:has(.tasks-layout)`. */
const railButton =
  'relative grid size-10 place-items-center rounded-panel transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:border forced-colors:border-CanvasText'
const railButtonIdle = 'text-ink-2 hover:bg-hover hover:text-ink'
const railButtonActive = 'bg-active text-ink'

export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const path = () => location.pathname
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  const isChat = (): boolean => path() === '/' || path().startsWith('/chat')
  const isTasks = (): boolean => path().startsWith('/tasks')

  const title = (): string => {
    if (path().startsWith('/agents')) return app.t('agents')
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
    if (path().startsWith('/agents')) {
      const noNetwork = app.agents().filter((agent) => agent.networkMode === 'deny').length
      const parts = [app.t('screenRegistered', { count: app.agents().length })]
      if (noNetwork > 0) parts.push(app.t('screenNoNetwork', { count: noNetwork }))
      return parts.join(' · ')
    }
    if (path().startsWith('/approvals')) {
      return app.t('screenWaitingOnYou', { count: pendingApprovals() })
    }
    const parts: string[] = []
    if (pendingApprovals() > 0) parts.push(app.t('screenApprovals', { count: pendingApprovals() }))
    if (runningTasks() > 0) parts.push(app.t('screenRunning', { count: runningTasks() }))
    if (failedTasks() > 0) parts.push(app.t('screenFailed', { count: failedTasks() }))
    return parts.length === 0 ? app.t('allClear') : parts.join(' · ')
  }

  const connectionLabel = (): string => {
    const value = app.connection()
    if (value === 'live') return app.t('connected')
    if (value === 'connecting') return app.t('reconnecting')
    return app.t('offline')
  }

  const themeLabel = (): string => {
    if (app.theme.theme() === 'light') return app.t('themeLightLabel')
    if (app.theme.theme() === 'dark') return app.t('themeDarkLabel')
    return app.t('themeSystemLabel')
  }

  const themeIcon = (): 'sun' | 'moon' | 'monitor' =>
    app.theme.theme() === 'light' ? 'sun' : app.theme.theme() === 'dark' ? 'moon' : 'monitor'

  /* Cmd/Ctrl+K anywhere in the console; the dialog owns Escape and focus return. */
  onSettled(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
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
      <CommandPalette
        open={paletteOpen()}
        onOpenChange={setPaletteOpen}
        title={app.t('command')}
        placeholder={app.t('palettePlaceholder')}
        empty={app.t('paletteEmpty')}
        groups={paletteGroups()}
        onRun={runPalette}
      />
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
        <div class="mt-auto flex w-10 flex-col items-center gap-0.5 border-t border-line pt-2 max-[860px]:mt-0 max-[860px]:w-auto max-[860px]:flex-row max-[860px]:border-t-0 max-[860px]:pt-0">
          <IconButton
            icon={themeIcon()}
            label={themeLabel()}
            class={`${railButton} ${railButtonIdle}`}
            onClick={() => app.theme.cycleTheme()}
          />
          <button
            type="button"
            class={`${railButton} ${railButtonIdle}`}
            aria-label={app.t('language')}
            title={app.t('language')}
            onClick={() => app.setLocale(app.locale() === 'zh-CN' ? 'en-US' : 'zh-CN')}
          >
            <Icon name="globe" size={17} />
            <span
              class="absolute right-0 bottom-0 rounded-control bg-canvas px-0.5 text-badge font-semibold text-ink-2"
              aria-hidden="true"
            >
              {app.locale() === 'zh-CN' ? '中' : 'EN'}
            </span>
          </button>
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
            <span class="whitespace-nowrap text-badge text-ink-3 max-[560px]:hidden">
              {app.t('workspaceScope')}
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <span
              class="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-badge text-ink-2"
              title={app.t('eventsCount', { count: app.events().length })}
            >
              <span class={`status-dot is-${app.connection()}`} aria-hidden="true" />
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

          <Show when={app.token() === ''}>
            <div
              class="mx-6 mb-3 flex flex-none items-center justify-between gap-3 rounded-panel border border-line bg-surface px-3 py-2.5 max-[1100px]:mx-4"
              role="status"
            >
              <div class="min-w-0">
                <strong class="text-meta font-semibold text-ink">{app.t('tokenRequired')}</strong>
                <p class="mt-0.5 text-badge text-ink-2">{app.t('tokenRequiredHint')}</p>
              </div>
              <a class={buttonPrimary} href="/settings">
                {app.t('openSettings')}
              </a>
            </div>
          </Show>

          <div
            class={`screen-body ${
              isChat()
                ? 'chat-body'
                : isTasks()
                  ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                  : 'scroll-body'
            }`}
          >
            {props.children}
          </div>
        </div>
      </main>
    </div>
  )
}
