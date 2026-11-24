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
      <div class="section-heading">
        <span>{props.t('agents')}</span>
        <span class="muted num">{props.agents.length}</span>
      </div>
      <Show
        when={props.agents.length > 0}
        fallback={<p class="empty-state">{props.t('noAgents')}</p>}
      >
        <section class="table-scroll" tabindex="0" aria-label={props.t('agents')}>
          <table class="data-table">
            <thead>
              <tr>
                <th>{props.t('agent')}</th>
                <th>{props.t('status')}</th>
                <th>{props.t('command')}</th>
                <th>{props.t('network')}</th>
                <th>{props.t('capabilities')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.agents}>
                {(agent) => (
                  <tr>
                    <td>
                      <div class="agent-name">{agent.name}</div>
                      <div class="mono muted">{agent.id}</div>
                    </td>
                    <td>
                      <StatusBadge status={agent.status} label={props.t(statusKey(agent.status))} />
                    </td>
                    <td class="mono muted">{agent.command}</td>
                    <td class="muted">{agent.networkMode}</td>
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
  if (!Array.isArray(props.value) || props.value.length === 0) return <span class="muted">—</span>
  return (
    <div class="capability-list">
      <For each={props.value}>{(value) => <span class="chip">{String(value)}</span>}</For>
    </div>
  )
}
