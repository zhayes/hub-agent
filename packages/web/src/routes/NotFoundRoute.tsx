import { useApp } from '../app/store'

export function NotFoundRoute() {
  const app = useApp()
  return (
    <section class="empty-state centered">
      <p>{app.t('unknown')}</p>
      <a href="/tasks">{app.t('navTasks')}</a>
    </section>
  )
}
