import { useApp } from '../app/store'

export function NotFoundRoute() {
  const app = useApp()
  return (
    <section class="flex min-h-[220px] flex-col items-center justify-center gap-2.5 px-8 py-8 text-center text-meta text-ink-2">
      <p>{app.t('unknown')}</p>
      <a
        class="text-accent underline underline-offset-2 transition-colors hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href="/tasks"
      >
        {app.t('navTasks')}
      </a>
    </section>
  )
}
