import { useLocation } from '@solidjs/router'
import type { JSX } from '@solidjs/web'
import { For, Show } from 'solid-js'
import { Icon, type IconName } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
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

export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const path = () => location.pathname

  const isChat = (): boolean => path() === '/' || path().startsWith('/chat')

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

  return (
    <div class="app-shell">
      <aside class="rail" aria-label={app.t('appName')}>
        <a class="rail-brand" href="/chat" title={app.t('appName')}>
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
        <nav class="rail-nav" aria-label={app.t('primaryNavigation')}>
          <For each={NAV}>
            {(item) => (
              <a
                href={item.href}
                class={`rail-button${isActive(item.href) ? ' active' : ''}`}
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
                  <span class="rail-count" aria-hidden="true">
                    {pendingApprovals()}
                  </span>
                </Show>
              </a>
            )}
          </For>
        </nav>
        <div class="rail-bottom">
          <IconButton
            icon={themeIcon()}
            label={themeLabel()}
            class="rail-button"
            onClick={() => app.theme.cycleTheme()}
          />
          <button
            type="button"
            class="rail-button language-button"
            aria-label={app.t('language')}
            title={app.t('language')}
            onClick={() => app.setLocale(app.locale() === 'zh-CN' ? 'en-US' : 'zh-CN')}
          >
            <Icon name="globe" size={17} />
            <span class="rail-badge" aria-hidden="true">
              {app.locale() === 'zh-CN' ? '中' : 'EN'}
            </span>
          </button>
          <a
            href="/settings"
            class={`rail-button${isActive('/settings') ? ' active' : ''}`}
            aria-current={isActive('/settings') ? 'page' : undefined}
            aria-label={app.t('navSettings')}
            title={app.t('navSettings')}
          >
            <Icon name="settings" size={18} />
          </a>
        </div>
      </aside>

      <main class="main">
        <header class="app-bar">
          <div class="app-identity">
            <span class="app-name">{app.t('appName')}</span>
            <span class="app-scope">{app.t('workspaceScope')}</span>
          </div>
          <div class="app-bar-actions">
            <span
              class="connection-pill"
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

        <div class="screen">
          <div class="screen-head">
            <div class="screen-title">
              <h1>{title()}</h1>
              <Show when={note() !== ''}>
                <p class="screen-note">{note()}</p>
              </Show>
            </div>
          </div>

          <Show when={app.error() !== ''}>
            <div class="error-banner" role="alert">
              <Icon name="alert" size={15} />
              <span>
                {app.t('errorPrefix')}: {app.error()}
              </span>
            </div>
          </Show>

          <Show when={app.token() === ''}>
            <div class="token-gate" role="status">
              <div>
                <strong>{app.t('tokenRequired')}</strong>
                <p class="muted">{app.t('tokenRequiredHint')}</p>
              </div>
              <a class="solid-button" href="/settings">
                {app.t('openSettings')}
              </a>
            </div>
          </Show>

          <div class={`screen-body${isChat() ? ' chat-body' : ' scroll-body'}`}>
            {props.children}
          </div>
        </div>
      </main>
    </div>
  )
}
