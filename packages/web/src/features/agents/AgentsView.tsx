import { For, Show } from 'solid-js'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { AgentRow } from '../../shared/api'
import { statusKey, type Translator } from '../../shared/i18n'

export interface AgentsViewProps {
  agents: AgentRow[]
  t: Translator
}

export function AgentsView(props: AgentsViewProps) {
  return (
    <section class="table-panel" aria-label={props.t('agents')}>
      <Show
        when={props.agents.length > 0}
        fallback={<p class="empty-state">{props.t('noAgents')}</p>}
      >
        <section class="table-scroll" tabindex="0" aria-label={props.t('agents')}>
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-agent">{props.t('agent')}</th>
                <th class="col-status">{props.t('status')}</th>
                <th class="col-command">{props.t('command')}</th>
                <th class="col-network">{props.t('network')}</th>
                <th class="col-capabilities">{props.t('capabilities')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.agents}>
                {(agent) => (
                  <tr>
                    <td>
                      <div class="agent-name">{agent.name}</div>
                      <div class="mono faint">{agent.id}</div>
                    </td>
                    <td>
                      <StatusBadge status={agent.status} label={props.t(statusKey(agent.status))} />
                    </td>
                    <td class="mono muted">{agent.command}</td>
                    <td>
                      <span class={`network-tag network-${agent.networkMode}`}>
                        {agent.networkMode}
                      </span>
                    </td>
                    <td>
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
  if (!Array.isArray(props.value) || props.value.length === 0) return <span class="faint">—</span>
  return (
    <div class="capability-list">
      <For each={props.value}>{(value) => <span class="chip">{String(value)}</span>}</For>
    </div>
  )
}
