import { useNavigate, useParams } from '@solidjs/router'
import { createEffect } from 'solid-js'
import { useApp } from '../app/store'
import { ChatView } from '../features/chat/ChatView'
import { draft } from '../features/chat/draft'
import { lastThread } from '../features/chat/store'

/**
 * `/chat` 是目的地，`/chat/:id` 是具体一条会话。
 *
 * 中栏没有会话时回到上次打开的那条；但**草稿态**例外——点「创建新工作区」
 * 之后不该被“回到上次对话”顶掉，否则用户永远开不了新会话。
 */
export function ChatRoute() {
  const params = useParams()
  const navigate = useNavigate()

  const threadId = (): string | undefined => {
    const value = params.id
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  createEffect(
    () => ({ id: threadId(), drafting: draft.active() }),
    (value) => {
      if (value.id !== undefined) return
      if (value.drafting) return
      const last = lastThread()
      if (last !== undefined) navigate(`/chat/${last}`, { replace: true })
    },
  )

  return <ChatSurface threadId={threadId()} />
}

/**
 * 对话正文的可复用外壳：路由与任务深链共用同一份接线，避免两处各写一遍。
 */
export function ChatSurface(props: { threadId?: string }) {
  const app = useApp()
  const navigate = useNavigate()

  /* 选中了一条真实会话 → 草稿态结束（否则 /chat 会一直在草稿模式）。 */
  createEffect(
    () => props.threadId,
    (id) => {
      if (id !== undefined) draft.end()
    },
  )

  return (
    <ChatView
      threadId={props.threadId}
      locale={app.locale()}
      t={app.t}
      events={app.events()}
      tasks={app.tasks()}
      approvals={app.approvals()}
      agents={app.agents()}
      onOpenThread={(id) => navigate(`/chat/${id}`)}
      onRefreshThreads={app.refreshThreads}
      onClearThread={() => navigate('/chat')}
    />
  )
}
