import { For, Show } from 'solid-js'
import { useApp } from '../../app/store'
import { RegistryView } from '../registry/RegistryView'
import { StageEntry } from './office/stage-entry'

/**
 * `/agents` 与 `/registry` 是**同一个目的地的两个分段**（ADR 0029 §2.2）：
 * 现场（3D 工位）与接入（catalog 扫描与授权）。
 *
 * 分段控件从顶栏挪到页面里：顶栏在 ≤560px 会把分段藏掉，那时手机上就无法
 * 在两个分段之间切换；页面内的分段控件在任何宽度都在。顶栏则按深链页的规矩
 * 显示页名「Agent」。
 *
 * 切换分段会卸载 3D 舞台（释放 GPU 与 three 场景），不是隐藏在列表后面继续渲染。
 */

export type AgentSection = 'stage' | 'access'

const SEGMENTS: ReadonlyArray<{
  key: AgentSection
  href: string
  label: 'sectionStage' | 'sectionAccess'
}> = [
  { key: 'stage', href: '/agents', label: 'sectionStage' },
  { key: 'access', href: '/registry', label: 'sectionAccess' },
]

const segment =
  'inline-flex h-[30px] items-center rounded-control px-2.5 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const segmentActive = 'bg-raised font-semibold text-ink'
const segmentIdle = 'font-medium text-ink-3 hover:text-ink'

export function AgentsPage(props: { section: AgentSection }) {
  const app = useApp()

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <nav
        class="flex flex-none items-center gap-0.5 px-5 pt-3 max-[860px]:px-4 max-[860px]:pt-2"
        aria-label={app.t('agents')}
      >
        <For each={SEGMENTS}>
          {(item) => (
            <a
              href={item.href}
              class={`${segment} ${props.section === item.key ? segmentActive : segmentIdle}`}
              aria-current={props.section === item.key ? 'page' : undefined}
            >
              {app.t(item.label)}
            </a>
          )}
        </For>
      </nav>

      <Show
        when={props.section === 'stage'}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col">
            <RegistryView />
          </div>
        }
      >
        <div class="min-h-0 flex-1 p-4 max-[860px]:p-3">
          <StageEntry />
        </div>
      </Show>
    </div>
  )
}
