import { createRouter } from '@solidjs/router'
import { AgentsRoute } from '../routes/AgentsRoute'
import { ApprovalsRoute } from '../routes/ApprovalsRoute'
import { ChatRoute } from '../routes/ChatRoute'
import { NotFoundRoute } from '../routes/NotFoundRoute'
import { SettingsRoute } from '../routes/SettingsRoute'
import { TasksRoute } from '../routes/TasksRoute'
import { AppLayout } from './AppLayout'

export const Router = createRouter({
  routes: [
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '/', component: ChatRoute },
        { path: '/chat', component: ChatRoute },
        { path: '/chat/:id', component: ChatRoute },
        { path: '/tasks', component: TasksRoute },
        { path: '/tasks/:id', component: TasksRoute },
        { path: '/agents', component: AgentsRoute },
        { path: '/approvals', component: ApprovalsRoute },
        { path: '/settings', component: SettingsRoute },
        { path: '*404', component: NotFoundRoute },
      ],
    },
  ],
})
