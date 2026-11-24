import { useNavigate, useParams } from '@solidjs/router'
import { useApp } from '../app/store'
import { ChatView } from '../features/chat/ChatView'

export function ChatRoute() {
  const app = useApp()
  const params = useParams()
  const navigate = useNavigate()
  return (
    <ChatView
      threadId={typeof params.id === 'string' ? params.id : undefined}
      locale={app.locale()}
      t={app.t}
      events={app.events()}
      tasks={app.tasks()}
      onOpenThread={(id) => navigate(`/chat/${id}`)}
      onOpenTask={(id) => navigate(`/tasks/${id}`)}
    />
  )
}
