import { useLocation } from '@solidjs/router'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { Icon } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { useApp } from './store'

export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const path = () => location.pathname

  const title = (): string => {
    if (path().startsWith('/agents')) return app.t('agents')
    if (path().startsWith('/approvals')) return app.t('approvals')
    if (path().startsWith('/settings')) return app.t('settings')
    if (path().startsWith('/chat') || path() === '/') return app.t('chat')
    return app.t('tasks')
  }

  const isActive = (prefix: string): boolean =>
    prefix === '/tasks'
      ? path() === '/tasks' || path().startsWith('/tasks/')
      : path().startsWith(prefix)

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
        <div class="brand-mark" aria-hidden="true">
          H
        </div>
        <nav class="rail-nav" aria-label={app.t('primaryNavigation')}>
          <a
            href="/chat"
            class={`rail-button${isActive('/chat') ? ' active' : ''}`}
            aria-current={isActive('/chat') ? 'page' : undefined}
            aria-label={app.t('navChat')}
            title={app.t('navChat')}
          >
            <Icon name="message" size={17} />
          </a>
          <a
            href="/tasks"
            class={`rail-button${isActive('/tasks') ? ' active' : ''}`}
            aria-current={isActive('/tasks') ? 'page' : undefined}
            aria-label={app.t('navTasks')}
            title={app.t('navTasks')}
          >
            <Icon name="tasks" size={17} />
          </a>
          <a
            href="/agents"
            class={`rail-button${isActive('/agents') ? ' active' : ''}`}
            aria-current={isActive('/agents') ? 'page' : undefined}
            aria-label={app.t('navAgents')}
            title={app.t('navAgents')}
          >
            <Icon name="agents" size={17} />
          </a>
          <a
            href="/approvals"
            class={`rail-button${isActive('/approvals') ? ' active' : ''}`}
            aria-current={isActive('/approvals') ? 'page' : undefined}
            aria-label={app.t('navApprovals')}
            title={app.t('navApprovals')}
          >
            <Icon name="approvals" size={17} />
          </a>
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
            <Icon name="globe" size={16} />
            <span class="rail-badge">{app.locale() === 'zh-CN' ? '中' : 'EN'}</span>
          </button>
          <a
            href="/settings"
            class={`rail-button${isActive('/settings') ? ' active' : ''}`}
            aria-current={isActive('/settings') ? 'page' : undefined}
            aria-label={app.t('navSettings')}
            title={app.t('navSettings')}
          >
            <Icon name="settings" size={17} />
          </a>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <div class="eyebrow">{app.t('appSubtitle')}</div>
            <h1>{title()}</h1>
            <div class="connection">
              <span class={`status-dot ${app.connection()}`} aria-hidden="true" />
              <span>
                {app.connection() === 'live'
                  ? app.t('connected')
                  : app.connection() === 'connecting'
                    ? app.t('reconnecting')
                    : app.t('live')}
              </span>
              <span class="muted">·</span>
              <span class="muted num">{app.events().length}</span>
            </div>
          </div>
          <div class="topbar-actions">
            <IconButton
              icon="refresh"
              label={app.t('refresh')}
              onClick={() => void app.refresh()}
            />
          </div>
        </header>

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

        {props.children}
      </main>
    </div>
  )
}
