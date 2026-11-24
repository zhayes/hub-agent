import { createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import {
  type AgentRow,
  type ApprovalRow,
  api,
  type Decision,
  getToken,
  saveToken,
  type TaskRow,
  type TaskView,
} from './api'

type View = 'tasks' | 'agents' | 'approvals'

export default function App() {
  const [view, setView] = createSignal<View>('tasks')
  const [tasks, setTasks] = createSignal<TaskRow[]>([])
  const [agents, setAgents] = createSignal<AgentRow[]>([])
  const [approvals, setApprovals] = createSignal<ApprovalRow[]>([])
  const [selected, setSelected] = createSignal<TaskView>()
  const [decisions, setDecisions] = createSignal<Decision[]>([])
  const [events, setEvents] = createSignal<string[]>([])
  const [error, setError] = createSignal('')
  const [token, setToken] = createSignal(getToken())
  let source: EventSource | undefined

  const refresh = async () => {
    try {
      setError('')
      const [t, a, p] = await Promise.all([api.tasks(), api.agents(), api.approvals()])
      setTasks(t.tasks)
      setAgents(a.agents)
      setApprovals(p.approvals)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openTask = async (id: string) => {
    try {
      setError('')
      const [task, decision] = await Promise.all([api.task(id), api.decisions(id)])
      setSelected(task)
      setDecisions(decision.decisions)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const decide = async (id: string, action: 'approve' | 'reject') => {
    try {
      await (action === 'approve' ? api.approve(id) : api.reject(id))
      await refresh()
      const current = selected()
      if (current !== undefined) await openTask(current.task.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const connectEvents = () => {
    source?.close()
    const current = getToken()
    if (current === '') return
    source = new EventSource(
      `/api/v1/events/stream?sinceSeq=0&token=${encodeURIComponent(current)}`,
    )
    source.addEventListener('hubagent', (event) => {
      setEvents((previous) => [event.data, ...previous].slice(0, 30))
    })
    source.onerror = () => {
      // EventSource reconnects automatically; don't spam the UI.
    }
  }

  onSettled(() => {
    if (getToken() !== '') void refresh()
    connectEvents()
  })
  onCleanup(() => source?.close())

  return (
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">HubAgent</div>
        <div class="muted">Local multi-agent console</div>
        <nav>
          <button
            type="button"
            class={{ active: view() === 'tasks' }}
            onClick={() => setView('tasks')}
          >
            Tasks
          </button>
          <button
            type="button"
            class={{ active: view() === 'agents' }}
            onClick={() => setView('agents')}
          >
            Agents
          </button>
          <button
            type="button"
            class={{ active: view() === 'approvals' }}
            onClick={() => setView('approvals')}
          >
            Approvals
          </button>
        </nav>
        <div class="token-box">
          <label for="api-token">API token</label>
          <input
            id="api-token"
            value={token()}
            placeholder="Bearer token"
            onInput={(event) => setToken(event.currentTarget.value)}
          />
          <button
            type="button"
            onClick={() => {
              saveToken(token())
              void refresh()
              connectEvents()
            }}
          >
            Use token
          </button>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <h1>{view() === 'tasks' ? 'Tasks' : view() === 'agents' ? 'Agents' : 'Approvals'}</h1>
            <p class="muted">Live local state · {events().length} streamed events</p>
          </div>
          <button type="button" class="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </header>

        <Show when={error() !== ''}>
          <div class="error">{error()}</div>
        </Show>

        <Show when={view() === 'tasks'}>
          <div class="split">
            <section class="list">
              <For each={tasks()}>
                {(task) => (
                  <button type="button" class="row" onClick={() => void openTask(task.id)}>
                    <span class={`pill ${task.status}`}>{task.status}</span>
                    <span class="row-title">{task.title}</span>
                    <span class="mono muted">{task.id.slice(-8)}</span>
                  </button>
                )}
              </For>
              <Show when={tasks().length === 0}>
                <p class="muted">No tasks yet.</p>
              </Show>
            </section>

            <section class="detail">
              <Show
                when={selected()}
                fallback={<p class="muted">Select a task to inspect evidence and decisions.</p>}
              >
                {(task) => (
                  <>
                    <div class="detail-head">
                      <h2>{task().task.title}</h2>
                      <span class={`pill ${task().task.status}`}>{task().task.status}</span>
                    </div>
                    <h3>Subtasks</h3>
                    <For each={task().subtasks}>
                      {(subtask) => (
                        <div class="line">
                          <span class={`pill ${subtask.status}`}>{subtask.status}</span>
                          {subtask.title}
                        </div>
                      )}
                    </For>
                    <h3>Executions & evidence</h3>
                    <For each={task().executions}>
                      {(execution) => (
                        <div class="card">
                          <div class="line">
                            <strong>{execution.id}</strong>
                            <span class={`pill ${execution.status}`}>{execution.status}</span>
                          </div>
                          <div class="mono muted">
                            attempt {execution.attempt} ·{' '}
                            {execution.evidence?.branch ?? 'no branch'} ·{' '}
                            {execution.evidence?.commitSha?.slice(0, 8) ?? '-'}
                          </div>
                          <Show when={execution.evidence?.diffstat}>
                            <pre>{execution.evidence?.diffstat}</pre>
                          </Show>
                          <Show when={execution.evidence?.transcriptRef}>
                            <div class="mono muted">{execution.evidence?.transcriptRef}</div>
                          </Show>
                        </div>
                      )}
                    </For>
                    <h3>Verification</h3>
                    <For each={task().verifications}>
                      {(run) => (
                        <div class="card">
                          <div class="line">
                            <strong>{run.verdict}</strong>
                            <span class="mono muted">{run.id.slice(-8)}</span>
                          </div>
                          <For each={run.checks}>
                            {(check) => (
                              <div class="line">
                                <span class={`pill ${check.passed ? 'succeeded' : 'failed'}`}>
                                  {check.passed ? 'pass' : 'fail'}
                                </span>
                                <span>{check.kind}</span>
                                <span class="mono muted">
                                  {check.command ?? check.outputRef ?? ''}
                                </span>
                                <Show when={check.exitCode !== undefined}>
                                  <span class="mono">exit {check.exitCode}</span>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                    <h3>Decisions</h3>
                    <For each={decisions()}>
                      {(decision) => (
                        <div class="card">
                          <div class="mono muted">
                            {decision.type} · {new Date(decision.decidedAt).toLocaleString()}
                          </div>
                          <p>{decision.rationale}</p>
                        </div>
                      )}
                    </For>
                    <h3>Approvals</h3>
                    <For each={task().approvals}>
                      {(approval) => (
                        <div class="card">
                          <div class="line">
                            <strong>{approval.reason}</strong>
                            <span class={`pill ${approval.status}`}>{approval.status}</span>
                          </div>
                          <div class="mono muted">{approval.resource}</div>
                          <Show when={approval.status === 'pending'}>
                            <div class="actions">
                              <button
                                type="button"
                                onClick={() => void decide(approval.id, 'approve')}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                class="secondary"
                                onClick={() => void decide(approval.id, 'reject')}
                              >
                                Reject
                              </button>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </Show>
            </section>
          </div>
        </Show>

        <Show when={view() === 'agents'}>
          <div class="grid">
            <For each={agents()}>
              {(agent) => (
                <div class="card">
                  <div class="line">
                    <h2>{agent.name}</h2>
                    <span class={`pill ${agent.status}`}>{agent.status}</span>
                  </div>
                  <div class="mono muted">{agent.command}</div>
                  <div class="muted">network: {agent.networkMode}</div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={view() === 'approvals'}>
          <div class="grid">
            <For each={approvals()}>
              {(approval) => (
                <div class="card">
                  <div class="line">
                    <strong>{approval.reason}</strong>
                    <span class={`pill ${approval.status}`}>{approval.status}</span>
                  </div>
                  <div class="mono muted">{approval.resource}</div>
                  <div class="muted">{approval.taskId}</div>
                  <Show when={approval.status === 'pending'}>
                    <div class="actions">
                      <button type="button" onClick={() => void decide(approval.id, 'approve')}>
                        Approve
                      </button>
                      <button
                        type="button"
                        class="secondary"
                        onClick={() => void decide(approval.id, 'reject')}
                      >
                        Reject
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <section class="stream">
          <h3>Event stream</h3>
          <For each={events().slice(0, 8)}>{(event) => <pre class="event">{event}</pre>}</For>
        </section>
      </main>
    </div>
  )
}
