import { useParams } from '@solidjs/router'
import { createEffect, Show } from 'solid-js'
import { inspector } from '../app/inspector'
import { useApp } from '../app/store'
import { TaskListView } from '../features/tasks/TaskListView'
import { ChatSurface } from './ChatRoute'

/**
 * `/tasks` 是运行索引，`/tasks/:id` 打开一次运行的详情。
 *
 * 详情不再是整页，而是右栏：中栏留在这条运行所属的对话里，判断与证据并排看。
 * 运行找不到来源会话时（CLI 造的、旧的）中栏退回索引，右栏照样可以看。
 */
export function TasksRoute() {
  const app = useApp()
  const params = useParams()

  const taskId = (): string | undefined => {
    const value = params.id
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  createEffect(
    () => taskId(),
    (id) => {
      if (id !== undefined) inspector.openTask(id)
    },
  )

  const threadId = (): string | undefined => {
    const id = taskId()
    if (id === undefined) return undefined
    return app.threads().find((thread) => thread.taskId === id)?.id
  }

  return (
    <Show
      when={threadId()}
      fallback={
        <TaskListView
          tasks={app.tasks()}
          approvals={app.approvals()}
          locale={app.locale()}
          t={app.t}
        />
      }
    >
      {(id) => <ChatSurface threadId={id()} />}
    </Show>
  )
}
