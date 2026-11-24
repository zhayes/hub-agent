import { useNavigate, useParams } from '@solidjs/router'
import { createEffect } from 'solid-js'
import { useApp } from '../app/store'
import { TasksView } from '../features/tasks/TasksView'

export function TasksRoute() {
  const app = useApp()
  const params = useParams()
  const navigate = useNavigate()

  createEffect(
    () => params.id,
    (id) => {
      if (typeof id === 'string' && id.length > 0) void app.openTask(id)
    },
  )

  return (
    <TasksView
      tasks={app.tasks()}
      selected={app.selected()}
      decisions={app.decisions()}
      events={app.events()}
      locale={app.locale()}
      t={app.t}
      onSelect={(id) => navigate(`/tasks/${id}`)}
      onApprove={(id) => void app.decide(id, 'approve')}
      onReject={(id) => void app.decide(id, 'reject')}
    />
  )
}
