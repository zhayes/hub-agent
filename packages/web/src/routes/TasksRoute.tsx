import { useParams } from '@solidjs/router'
import { createEffect, createSignal, Show } from 'solid-js'
import { useApp } from '../app/store'
import { TaskDetailView } from '../features/tasks/TaskDetailView'
import { TaskListView } from '../features/tasks/TaskListView'
import { chatApi } from '../shared/api'

interface SourceThread {
  id: string
  title: string
}

/**
 * `/tasks` 是深链入口，`/tasks/:id` 是运行详情（ADR 0029 §2.2：任务是对象，不是地点）。
 *
 * 详情页要显示「来自对话《…》」——对象关系必须双向可达（§4.3）。
 * 会话列表只有 50 条上限、也没有按 taskId 查询的接口，所以这里退而求其次：
 * 在最近 50 条里找第一个 taskId 命中的；找不到就不显示回链，不编标题。
 */
export function TasksRoute() {
  const app = useApp()
  const params = useParams()
  const [thread, setThread] = createSignal<SourceThread>()

  const taskId = (): string | undefined => {
    const value = params.id
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  const loadThread = async (id: string): Promise<void> => {
    try {
      const result = await chatApi.threads()
      /* 切任务比请求快时，旧的响应不能覆盖新的标题。 */
      if (taskId() !== id) return
      const found = result.threads.find((entry) => entry.taskId === id)
      setThread(found === undefined ? undefined : { id: found.id, title: found.title })
    } catch {
      /* 回链是附加信息：取不到就不显示，不要把整页弄成错误态。 */
      if (taskId() === id) setThread(undefined)
    }
  }

  createEffect(
    () => taskId(),
    (id) => {
      setThread(undefined)
      if (id === undefined) return
      void app.openTask(id)
      void loadThread(id)
    },
  )

  /* 只认 id 与当前路由一致的那份详情：切任务时不会先画上一题的结论。 */
  const view = () => {
    const id = taskId()
    const current = app.selected()
    return current !== undefined && current.task.id === id ? current : undefined
  }

  return (
    <Show
      when={taskId()}
      fallback={
        <TaskListView
          tasks={app.tasks()}
          approvals={app.approvals()}
          locale={app.locale()}
          t={app.t}
        />
      }
    >
      {(id) => (
        <Show
          when={view()}
          fallback={
            <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-meta text-ink-2">
              <Show
                when={app.error() === ''}
                fallback={<p class="max-w-[52ch] text-danger">{app.error()}</p>}
              >
                <p>{app.t('taskLoading')}</p>
                <span class="font-mono text-badge text-ink-3" title={id()}>
                  {id()}
                </span>
              </Show>
            </div>
          }
        >
          {(current) => (
            <TaskDetailView
              view={current()}
              decisions={app.decisions()}
              events={app.events()}
              agents={app.agents()}
              sourceThread={thread()}
              locale={app.locale()}
              t={app.t}
              onApprove={(approvalId) => void app.decide(approvalId, 'approve')}
              onReject={(approvalId) => void app.decide(approvalId, 'reject')}
            />
          )}
        </Show>
      )}
    </Show>
  )
}
