import { useApp } from '../../app/store'
import { Icon } from '../../components/ui/Icon'
import { StageEntry } from './office/stage-entry'

/**
 * `/agents`：Agent 活动大屏（现场）。
 *
 * 接入（catalog 扫描与授权）不再是与现场并列的分段——它属于「配置」，
 * 住在设置的 `Agent 接入` 一节里。现场页面只留一个去那里的入口。
 */
export function AgentsPage() {
  const app = useApp()

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <header class="flex h-11 flex-none items-center gap-3 border-b border-line px-4">
        <h1 class="min-w-0 flex-1 truncate text-meta font-semibold text-ink">
          {app.t('agentStage')}
        </h1>
        <a
          class="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-control px-2 text-badge font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href="/settings/agents"
        >
          <Icon name="plug" size={14} />
          {app.t('settingsAgents')}
        </a>
      </header>
      <div class="min-h-0 flex-1 p-4 max-[860px]:p-3">
        <StageEntry />
      </div>
    </div>
  )
}
