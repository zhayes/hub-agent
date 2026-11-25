import { For, Show } from 'solid-js'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { AgentRow } from '../../shared/api'
import { statusKey, type Translator } from '../../shared/i18n'

export interface AgentsViewProps {
  agents: AgentRow[]
  t: Translator
}

const emptyState =
  'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2'

const thBase =
  'border-b border-line px-3 py-2 text-left text-meta font-medium whitespace-nowrap text-ink-2'
const tdBase = 'border-b border-line p-3 align-top'

/* Chips are 20px tall mono labels. Legacy forced-colors painted a 1px border. */
const tagBase =
  'inline-flex h-5 items-center rounded-control px-2 font-mono text-badge forced-colors:border forced-colors:border-CanvasText'

function networkTone(mode: string): string {
  if (mode === 'allowlist') return 'bg-warning-soft text-warning'
  if (mode === 'open') return 'bg-danger-soft text-danger'
  return 'bg-subtle text-ink-2'
}

export function AgentsView(props: AgentsViewProps) {
  return (
    <section class="pb-6" aria-label={props.t('agents')}>
      <Show
        when={props.agents.length > 0}
        fallback={<p class={emptyState}>{props.t('noAgents')}</p>}
      >
        <section
          class="overflow-x-auto border-t border-line focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          tabindex="0"
          aria-label={props.t('agents')}
        >
          <table class="w-full border-collapse text-meta">
            <thead>
              <tr>
                <th class={`${thBase} w-[26%]`}>{props.t('agent')}</th>
                <th class={`${thBase} w-[110px]`}>{props.t('status')}</th>
                <th class={`${thBase} w-[24%]`}>{props.t('command')}</th>
                <th class={`${thBase} w-[120px]`}>{props.t('network')}</th>
                <th class={thBase}>{props.t('capabilities')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.agents}>
                {(agent) => (
                  <tr>
                    <td class={tdBase}>
                      <div class="text-meta font-medium text-ink">{agent.name}</div>
                      <div class="mt-0.5 font-mono text-badge text-ink-3">{agent.id}</div>
                    </td>
                    <td class={tdBase}>
                      <StatusBadge status={agent.status} label={props.t(statusKey(agent.status))} />
                    </td>
                    <td class={`${tdBase} font-mono text-ink-2`}>{agent.command}</td>
                    <td class={tdBase}>
                      <span class={`${tagBase} ${networkTone(agent.networkMode)}`}>
                        {agent.networkMode}
                      </span>
                    </td>
                    <td class={tdBase}>
                      <Capabilities value={agent.capabilities} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Show>
    </section>
  )
}

function Capabilities(props: { value: unknown }) {
  if (!Array.isArray(props.value) || props.value.length === 0)
    return <span class="text-ink-3">—</span>
  return (
    <div class="flex flex-wrap gap-1">
      <For each={props.value}>
        {(value) => <span class={`${tagBase} bg-subtle text-ink-2`}>{String(value)}</span>}
      </For>
    </div>
  )
}
