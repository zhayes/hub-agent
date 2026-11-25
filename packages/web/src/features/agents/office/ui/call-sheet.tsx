import { For, Show } from 'solid-js'
import { StatusDot } from '../../../../components/ui/StatusBadge'
import type { AgentPresence } from '../../../../shared/api'
import type { OfficeTranslate } from '../strings'

export interface CallSheetProps {
  agents: AgentPresence[]
  selectedId: string | undefined
  labelOf: (agent: AgentPresence) => string
  attentionOf: (agent: AgentPresence) => boolean
  onSelect: (agent: AgentPresence) => void
  t: OfficeTranslate
}

const seatBase =
  'flex min-w-[9rem] shrink-0 items-center gap-2 rounded-panel border bg-surface/90 px-2.5 py-1.5 text-left shadow-card transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * 2D DOM 控制层：名单 + 选中（它是 3D 视图的控制层，不是 2D 降级视图）。
 * 键盘可达；注意力用边框高亮，不靠颜色单独传达。
 */
export function CallSheet(props: CallSheetProps) {
  return (
    <div class="pointer-events-auto absolute inset-x-4 bottom-4 z-10 flex items-stretch gap-2 overflow-x-auto pr-40">
      <span class="sr-only">{props.t('callSheet')}</span>
      <Show when={props.agents.length === 0}>
        <span class="rounded-panel border border-line bg-surface/90 px-3 py-2 text-badge text-ink-2">
          {props.t('ignoreEmpty')}
        </span>
      </Show>
      <For each={props.agents}>
        {(agent) => (
          <button
            type="button"
            class={[
              seatBase,
              {
                'border-accent': props.selectedId === agent.id,
                'border-warning': props.attentionOf(agent) && props.selectedId !== agent.id,
                'border-line': !props.attentionOf(agent) && props.selectedId !== agent.id,
              },
            ]}
            aria-pressed={props.selectedId === agent.id ? 'true' : 'false'}
            onClick={() => props.onSelect(agent)}
          >
            <StatusDot status={badgeStatus(agent)} />
            <span class="min-w-0">
              <span class="block truncate text-meta font-medium text-ink">{agent.name}</span>
              <span class="block truncate font-mono text-badge text-ink-3">
                {props.labelOf(agent)}
              </span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

function badgeStatus(agent: AgentPresence): string {
  if (agent.presence === 'error') return 'failed'
  if (agent.presence === 'busy') return 'running'
  if (agent.presence === 'online') return 'idle'
  if (agent.presence === 'degraded') return 'waiting'
  if (agent.presence === 'offline' || agent.presence === 'disabled') return 'offline'
  return 'idle'
}
