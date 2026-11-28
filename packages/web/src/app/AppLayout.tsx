import { useLocation, useNavigate } from '@solidjs/router'
import { dynamic, type JSX } from '@solidjs/web'
import { createEffect, createSignal, onCleanup, onFlush, onSettled, Show } from 'solid-js'
import type { CommandPaletteProps, PaletteGroup } from '../components/ui/CommandPalette'
import { Icon } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { Toaster } from '../components/ui/Toaster'
import { InboxPanel } from '../features/inbox/InboxPanel'
import { deriveAttention } from '../shared/attention'
import { InspectorPanel } from './InspectorPanel'
import { inspector } from './inspector'
import { Sidebar } from './Sidebar'
import { useApp } from './store'

/* The palette drags the SDK's command + dialog + popup foundation (~180 kB) into
   whatever chunk imports it, so it only loads once someone presses ⌘K. */
const LazyCommandPalette = dynamic(() =>
  import('../components/ui/CommandPalette').then((module) => module.CommandPalette),
) as unknown as (props: CommandPaletteProps) => JSX.Element

/**
 * 控制台外壳：左栏（工作区）· 中栏（正在做的事）· 右栏（运行详情）。
 *
 * 没有顶栏。顶栏的问题不是高，而是它把“我在哪个工作区、跑着什么”切成两处：
 * 导航在上、会话在抽屉里、注意力又是一颗胶囊。现在三件事各归一栏：
 * 换工作区在左，干活在中，看证据在右；注意力只在左栏出现，且没有待办时不出现。
 */
export function AppLayout(props: { children?: JSX.Element }) {
  const app = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const path = () => location.pathname
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteLoaded, setPaletteLoaded] = createSignal(false)
  const [inboxOpen, setInboxOpen] = createSignal(false)
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  let drawerEl: HTMLDivElement | undefined

  /* 抽屉要有自己的 Escape 与初始焦点：按钮在抽屉外，键盘事件不会自己传进来。 */
  createEffect(
    () => sidebarOpen(),
    (open) => {
      if (!open) return
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setSidebarOpen(false)
      }
      window.addEventListener('keydown', onKey)
      onCleanup(() => window.removeEventListener('keydown', onKey))
      queueMicrotask(() => drawerEl?.focus())
    },
  )

  const isChat = (): boolean => path() === '/' || path().startsWith('/chat')

  /* 注意力只有一个口径：审批 + 等你输入的任务，由 shared/attention 派生。 */
  const attentionItems = () => deriveAttention({ approvals: app.approvals(), tasks: app.tasks() })
  const attentionCount = (): number => attentionItems().length

  const title = (): string => {
    if (path().startsWith('/agents') || path().startsWith('/registry')) return app.t('agents')
    if (path().startsWith('/approvals')) return app.t('approvals')
    if (path().startsWith('/settings')) return app.t('settings')
    if (isChat()) return app.t('chat')
    return app.t('tasks')
  }

  /* 浮层挂在 layout 上，路由不会把它卸载：跳转时必须自己关掉。
     右栏同理：离开“这次运行”的深链就收起，不把上一份报告带到新页面里。 */
  createEffect(
    () => path(),
    (current) => {
      setInboxOpen(false)
      setPaletteOpen(false)
      setSidebarOpen(false)
      if (!current.startsWith('/tasks/')) inspector.close()
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
        { value: 'nav:/tasks', label: app.t('navTasks') },
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
    <div class="flex h-dvh min-h-0 overflow-hidden">
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

      {/* ≥961px 常驻左栏；再窄就变成可召回的抽屉（拇指区，不抢正文宽度）。 */}
      <div class="hidden min-h-0 min-[961px]:flex">
        <Sidebar
          locale={app.locale()}
          t={app.t}
          attentionCount={attentionCount()}
          onOpenInbox={() => setInboxOpen(true)}
        />
      </div>

      <Show when={sidebarOpen()}>
        <div
          class="fixed inset-0 z-40 bg-ink/25"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
        <div
          ref={(node) => {
            drawerEl = node
          }}
          tabindex="-1"
          class="hx-drawer fixed inset-y-0 left-0 z-50 flex max-w-[88vw] flex-col border-r border-line bg-canvas focus:outline-none"
          role="dialog"
          aria-label={app.t('primaryNavigation')}
        >
          <Sidebar
            locale={app.locale()}
            t={app.t}
            attentionCount={attentionCount()}
            onOpenInbox={() => setInboxOpen(true)}
            onNavigate={() => setSidebarOpen(false)}
          />
        </div>
      </Show>

      <div class="relative flex min-h-0 min-w-0 flex-1">
        <main class="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 窄屏才有的条：左栏收进抽屉后，需要一个召回入口与当前页面名。 */}
          <div class="flex h-12 flex-none items-center gap-1.5 border-b border-line px-2 min-[961px]:hidden">
            <IconButton
              icon="panelLeft"
              label={app.t('toggleSidebar')}
              onClick={() => setSidebarOpen(true)}
            />
            <span class="min-w-0 flex-1 truncate text-meta font-semibold text-ink">{title()}</span>
          </div>

          <Show when={app.error() !== ''}>
            <div
              class="mx-3 mb-2 flex flex-none items-center gap-2 rounded-panel bg-danger-soft px-3 py-2 text-meta text-danger"
              role="alert"
            >
              <span class="shrink-0">
                <Icon name="alert" size={15} />
              </span>
              <span class="min-w-0">
                {app.t('errorPrefix')}: {app.error()}
              </span>
            </div>
          </Show>

          {/* 页面没有拿到注入的 token，说明它不是 daemon 托管的：给出唯一可执行的动作。 */}
          <Show when={app.token() === '' && !isChat()}>
            <div
              class="mx-3 mb-2 flex flex-none items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2"
              role="status"
            >
              <Icon name="key" size={15} class="shrink-0 text-ink-3" />
              <span class="min-w-0 flex-1 truncate text-meta text-ink-2">
                <strong class="font-semibold text-ink">{app.t('daemonOfflineTitle')}</strong>
                {' — '}
                {app.t('daemonOfflineHint')}
              </span>
            </div>
          </Show>

          <div class="flex min-h-0 flex-1 flex-col">{props.children}</div>
        </main>

        <InspectorPanel locale={app.locale()} t={app.t} />
      </div>
    </div>
  )
}
