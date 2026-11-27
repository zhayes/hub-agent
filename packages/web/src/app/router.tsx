import { createRouter, type RouteDefinition } from '@solidjs/router'
import { DevUiView } from '../dev/DevUiView'
import { AgentsRoute } from '../routes/AgentsRoute'
import { ApprovalsRoute } from '../routes/ApprovalsRoute'
import { ChatRoute } from '../routes/ChatRoute'
import { NotFoundRoute } from '../routes/NotFoundRoute'
import { RegistryRoute } from '../routes/RegistryRoute'
import { SettingsRoute } from '../routes/SettingsRoute'
import { TasksRoute } from '../routes/TasksRoute'
import { AppLayout } from './AppLayout'

const routes: RouteDefinition[] = [
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
      { path: '/registry', component: RegistryRoute },
      { path: '/approvals', component: ApprovalsRoute },
      { path: '/settings', component: SettingsRoute },
      { path: '*404', component: NotFoundRoute },
    ],
  },
]

// Dev-only gallery. The compile-time flag keeps it out of the production graph.
if (import.meta.env.DEV) {
  routes.unshift({ path: '/dev/ui', component: DevUiView })
}

export const Router = createRouter({ routes })
