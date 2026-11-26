import { useNavigate, useParams } from '@solidjs/router'
import { createEffect } from 'solid-js'
import { useApp } from '../app/store'
import { ChatView } from '../features/chat/ChatView'
import { lastThread } from '../features/chat/store'

export function ChatRoute() {
  const app = useApp()
  const params = useParams()
  const navigate = useNavigate()

  /* 从任务页/设置页回来时，路由是 /chat（没有 id）：回到上次打开的对话，
     而不是让用户面对一个空面板。 */
  createEffect(
    () => params.id,
    (id) => {
      if (typeof id === 'string' && id !== '') return
      const last = lastThread()
      if (last !== undefined) navigate(`/chat/${last}`, { replace: true })
    },
  )

  return (
    <ChatView
      threadId={typeof params.id === 'string' ? params.id : undefined}
      locale={app.locale()}
      t={app.t}
      events={app.events()}
      tasks={app.tasks()}
      onOpenThread={(id) => navigate(`/chat/${id}`)}
      onOpenTask={(id) => navigate(`/tasks/${id}`)}
      onClearThread={() => navigate('/chat')}
    />
  )
}
