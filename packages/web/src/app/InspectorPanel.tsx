import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { IconButton } from '../components/ui/IconButton'
import { LoadingState } from '../components/ui/LoadingState'
import { TaskDetailView } from '../features/tasks/TaskDetailView'
import { api, type Decision, type TaskView } from '../shared/api'
import type { Locale, Translator } from '../shared/i18n'
import { INSPECTOR_MAX, INSPECTOR_MIN, inspector } from './inspector'
import { useApp } from './store'

/**
 * 右栏：一次运行的完整报告。
 *
 * 它是观察面，不是新目的地：对话留在中栏，运行详情在这里展开。
 * 内容用 `TaskDetailView`（判决 + 证据 + 审批就地处理），不另造一份摘要——
 * 同一个运行在任务详情、浮层、这里必须是同一副样子。
 */
export function InspectorPanel(props: { locale: Locale; t: Translator }) {
  const app = useApp()
  const [view, setView] = createSignal<TaskView>()
  const [decisions, setDecisions] = createSignal<Decision[]>([])
  const [error, setError] = createSignal('')
  const [file, setFile] = createSignal<{
    path: string
    content: string
    truncated: boolean
    source: 'worktree' | 'project'
  }>()
  const [fileError, setFileError] = createSignal('')
  const [fileLoading, setFileLoading] = createSignal(false)
  /* 窄屏上右栏盖住中栏（w-full），宽屏上才是一条可拖的分栏。 */
  const [narrow, setNarrow] = createSignal(
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 1100px)').matches,
  )

  onSettled(() => {
    const query = window.matchMedia('(max-width: 1100px)')
    const update = (): void => {
      setNarrow(query.matches)
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

  const target = inspector.target
  const kind = (): 'closed' | 'task' | 'file' => target().kind
  const taskId = (): string | undefined => {
    const value = target()
    return value.kind === 'closed' ? undefined : value.taskId
  }
  const filePath = (): string => {
    const value = target()
    return value.kind === 'file' ? value.path : ''
  }
  const sourceThread = (): { id: string; title: string } | undefined => {
    const id = taskId()
    if (id === undefined) return undefined
    const found = app.threads().find((thread) => thread.taskId === id)
    return found === undefined ? undefined : { id: found.id, title: found.title }
  }

  /* 运行状态来自全局快照：结束时自动重取一次，不必为右栏另开一条 SSE。 */
  const currentStatus = createMemo(() => {
    const id = taskId()
    return id === undefined ? undefined : app.tasks().find((task) => task.id === id)?.status
  })

  const loadTask = (id: string): void => {
    setError('')
    void Promise.all([api.task(id), api.decisions(id)])
      .then(([task, decision]) => {
        if (taskId() !== id) return
        setView(task)
        setDecisions(decision.decisions)
      })
      .catch((cause) => {
        if (taskId() !== id) return
        setView(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  createEffect(
    () => {
      const id = taskId()
      if (id === undefined) return undefined
      /* currentStatus() 是依赖：运行结束时自动重取一次。 */
      return { id, status: currentStatus() }
    },
    (value) => {
      if (value === undefined) {
        setView(undefined)
        setDecisions([])
        setError('')
        return
      }
      setView((current) => (current?.task.id === value.id ? current : undefined))
      loadTask(value.id)
    },
  )

  createEffect(
    () => {
      if (kind() !== 'file') return undefined
      const id = taskId()
      const path = filePath()
      return id === undefined || path === '' ? undefined : { id, path }
    },
    (value) => {
      if (value === undefined) return
      setFile(undefined)
      setFileError('')
      setFileLoading(true)
      void api
        .taskFile(value.id, value.path)
        .then((result) => {
          if (taskId() !== value.id || filePath() !== value.path) return
          setFile(result.file)
        })
        .catch((cause) => {
          if (taskId() !== value.id || filePath() !== value.path) return
          setFileError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => setFileLoading(false))
    },
  )

  const decide = (approvalId: string, action: 'approve' | 'reject'): void => {
    void app.decide(approvalId, action).then(() => {
      const id = taskId()
      if (id !== undefined) loadTask(id)
    })
  }

  const startDrag = (event: PointerEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = inspector.width()
    const move = (moveEvent: PointerEvent): void => {
      inspector.setWidth(startWidth - (moveEvent.clientX - startX))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const nudge = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 64 : 16
    const grow = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
    if (grow === 0) return
    event.preventDefault()
    inspector.setWidth(inspector.width() + grow)
  }

  return (
    <Show when={kind() !== 'closed'}>
      <aside
        class="relative flex min-h-0 min-w-0 flex-none flex-col overflow-hidden border-l border-line bg-canvas max-[1100px]:absolute max-[1100px]:inset-0 max-[1100px]:z-30 max-[1100px]:border-l-0"
        style={{ width: narrow() ? '100%' : `${inspector.width()}px` }}
        aria-label={props.t('chatTaskView')}
      >
        <Show when={!narrow()}>
          {/* biome-ignore lint/a11y/useSemanticElements: no native element resizes a pane; role=separator is the ARIA pattern for it */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={props.t('chatTaskView')}
            aria-valuenow={inspector.width()}
            aria-valuemin={INSPECTOR_MIN}
            aria-valuemax={INSPECTOR_MAX}
            tabindex="0"
            class="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
            onPointerDown={startDrag}
            onKeyDown={nudge}
          />
        </Show>

        <header class="flex h-11 flex-none items-center gap-2 border-b border-line px-3">
          <Show
            when={kind() === 'file'}
            fallback={
              <span class="min-w-0 flex-1 truncate text-meta font-medium text-ink">
                {props.t('chatTaskView')}
              </span>
            }
          >
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-control px-1 py-1 text-meta text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => {
                const id = taskId()
                if (id !== undefined) inspector.openTask(id)
              }}
            >
              <Icon name="arrowLeft" size={14} />
              {props.t('chatTaskView')}
            </button>
            <span
              class="min-w-0 flex-1 truncate text-right font-mono text-badge text-ink-3"
              title={filePath()}
            >
              {filePath()}
            </span>
          </Show>
          <IconButton icon="x" label={props.t('closePanel')} onClick={() => inspector.close()} />
        </header>

        <div class="flex min-h-0 flex-1 flex-col">
          <Show when={kind() === 'task'}>
            <Show
              when={view()}
              fallback={
                <Show
                  when={error() === ''}
                  fallback={
                    <div class="flex flex-col items-start gap-3 px-4 py-4">
                      <p class="text-meta text-danger" role="alert">
                        {error()}
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          const id = taskId()
                          if (id !== undefined) loadTask(id)
                        }}
                      >
                        {props.t('chatRetry')}
                      </Button>
                    </div>
                  }
                >
                  <div class="px-4 py-4">
                    <LoadingState label={props.t('loading')} />
                  </div>
                </Show>
              }
            >
              {(current) => (
                <TaskDetailView
                  view={current()}
                  decisions={decisions()}
                  events={app.events()}
                  agents={app.agents()}
                  sourceThread={sourceThread()}
                  locale={props.locale}
                  t={props.t}
                  onApprove={(id) => decide(id, 'approve')}
                  onReject={(id) => decide(id, 'reject')}
                />
              )}
            </Show>
          </Show>

          <Show when={kind() === 'file'}>
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
              <Show when={fileLoading()}>
                <p class="text-badge text-ink-3">{props.t('chatFileLoading')}</p>
              </Show>
              <Show when={fileError() !== ''}>
                <p class="text-badge text-danger" role="alert">
                  {fileError()}
                </p>
              </Show>
              <Show when={file()}>
                {(current) => (
                  <pre class="overflow-auto rounded-panel border border-line bg-surface p-3 font-mono text-badge leading-relaxed text-ink">
                    {current().content}
                  </pre>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
