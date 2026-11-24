import { For, Show } from 'solid-js'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { ApprovalRow, Decision, TaskRow, TaskView } from '../../shared/api'
import { absoluteTime, relativeTime, shortenId } from '../../shared/format'
import { type Locale, statusKey, type Translator } from '../../shared/i18n'

export interface TasksViewProps {
  tasks: TaskRow[]
  selected: TaskView | undefined
  decisions: Decision[]
  events: string[]
  locale: Locale
  t: Translator
  onSelect: (id: string) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

function statusLabel(t: Translator, status: string): string {
  return t(statusKey(status))
}

function approvalLabel(t: Translator, approval: ApprovalRow): string {
  return approval.status === 'pending' ? t('approvalNeeded') : approval.status
}

interface EventSummary {
  type: string
  at: string
}

function parseEvent(raw: string): EventSummary | undefined {
  try {
    const value = JSON.parse(raw) as { type?: unknown; at?: unknown }
    if (typeof value.type !== 'string') return undefined
    return { type: value.type, at: typeof value.at === 'string' ? value.at : '' }
  } catch {
    return undefined
  }
}

export function TasksView(props: TasksViewProps) {
  return (
    <div class="page-stack">
      <div class="tasks-layout">
        <section class="task-queue" aria-label={props.t('tasks')}>
          <div class="section-heading">
            <span>{props.t('tasks')}</span>
            <span class="muted num">{props.tasks.length}</span>
          </div>
          <div class="task-list">
            <For each={props.tasks}>
              {(task) => (
                <button
                  type="button"
                  class={`task-row${props.selected?.task.id === task.id ? ' selected' : ''}`}
                  onClick={() => props.onSelect(task.id)}
                >
                  <StatusBadge status={task.status} label={statusLabel(props.t, task.status)} />
                  <span class="task-row-main">
                    <span class="task-row-title">{task.title}</span>
                    <span class="task-row-meta">
                      <span class="mono">{shortenId(task.id)}</span>
                      <span>{relativeTime(props.locale, task.createdAt)}</span>
                    </span>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              )}
            </For>
            <Show when={props.tasks.length === 0}>
              <p class="empty-state">{props.t('noTasks')}</p>
            </Show>
          </div>
        </section>

        <section class="task-detail" aria-live="polite">
          <Show
            when={props.selected}
            fallback={
              <div class="empty-state centered">
                <Icon name="tasks" size={20} />
                <p>{props.t('selectTask')}</p>
              </div>
            }
          >
            {(task) => (
              <>
                <header class="detail-header">
                  <div>
                    <div class="eyebrow mono">
                      {props.t('taskId')} · {task().task.id}
                    </div>
                    <h2>{task().task.title}</h2>
                    <div class="detail-meta">
                      <StatusBadge
                        status={task().task.status}
                        label={statusLabel(props.t, task().task.status)}
                      />
                      <span class="mono">{task().task.id}</span>
                    </div>
                  </div>
                  <IconButton
                    icon="copy"
                    label={props.t('copyTaskId')}
                    onClick={() => void navigator.clipboard?.writeText(task().task.id)}
                  />
                </header>

                <section class="detail-section">
                  <div class="section-heading">
                    <span>{props.t('subtasks')}</span>
                    <span class="muted num">{task().subtasks.length}</span>
                  </div>
                  <div class="subtask-list">
                    <For each={task().subtasks}>
                      {(subtask) => (
                        <div class="subtask-row">
                          <StatusBadge
                            status={subtask.status}
                            label={statusLabel(props.t, subtask.status)}
                          />
                          <span>{subtask.title}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                <section class="detail-section">
                  <div class="section-heading">
                    <span>{props.t('executions')}</span>
                    <span class="muted num">{task().executions.length}</span>
                  </div>
                  <For each={task().executions}>
                    {(execution) => (
                      <div class="execution-block">
                        <div class="execution-head">
                          <span class="mono">{shortenId(execution.id, 12)}</span>
                          <StatusBadge
                            status={execution.status}
                            label={statusLabel(props.t, execution.status)}
                          />
                          <span class="muted num">
                            {props.t('attempt')} {execution.attempt}
                          </span>
                        </div>
                        <div class="execution-evidence mono muted">
                          {execution.evidence?.branch ?? props.t('noBranch')} ·{' '}
                          {execution.evidence?.commitSha?.slice(0, 8) ?? '—'}
                        </div>
                        <Show when={execution.evidence?.diffstat}>
                          <pre class="diffstat">{execution.evidence?.diffstat}</pre>
                        </Show>
                        <Show when={execution.evidence?.transcriptRef}>
                          <div class="mono muted">{execution.evidence?.transcriptRef}</div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={task().executions.length === 0}>
                    <p class="empty-state">{props.t('noEvidence')}</p>
                  </Show>
                </section>

                <section class="detail-section">
                  <div class="section-heading">
                    <span>{props.t('verification')}</span>
                    <span class="muted num">{task().verifications.length}</span>
                  </div>
                  <For each={task().verifications}>
                    {(run) => (
                      <div class="verification-block">
                        <div class="execution-head">
                          <span class="mono">{shortenId(run.id, 12)}</span>
                          <StatusBadge
                            status={run.verdict}
                            label={statusLabel(props.t, run.verdict)}
                          />
                        </div>
                        <For each={run.checks}>
                          {(check) => (
                            <div class="check-row">
                              <StatusBadge
                                status={check.passed ? 'pass' : 'fail'}
                                label={check.passed ? 'pass' : 'fail'}
                              />
                              <span class="mono">{check.kind}</span>
                              <span class="mono muted check-command">
                                {check.command ?? check.outputRef ?? ''}
                              </span>
                              <Show when={check.exitCode !== undefined}>
                                <span class="mono muted">
                                  {props.t('commandExit', { code: check.exitCode ?? 0 })}
                                </span>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </section>

                <section class="detail-section">
                  <div class="section-heading">
                    <span>{props.t('decisions')}</span>
                    <span class="muted num">{props.decisions.length}</span>
                  </div>
                  <For each={props.decisions}>
                    {(decision) => (
                      <div class="decision-row">
                        <div class="decision-type mono">{decision.type}</div>
                        <p>{decision.rationale}</p>
                        <time class="mono muted" datetime={decision.decidedAt}>
                          {absoluteTime(props.locale, decision.decidedAt)}
                        </time>
                      </div>
                    )}
                  </For>
                  <Show when={props.decisions.length === 0}>
                    <p class="empty-state">{props.t('noDecisions')}</p>
                  </Show>
                </section>

                <section class="detail-section">
                  <div class="section-heading">
                    <span>{props.t('approvalItems')}</span>
                    <span class="muted num">{task().approvals.length}</span>
                  </div>
                  <For each={task().approvals}>
                    {(approval) => (
                      <div class="approval-row">
                        <div>
                          <div class="approval-title">
                            <StatusBadge
                              status={approval.status}
                              label={approvalLabel(props.t, approval)}
                            />
                            <span class="mono">{approval.reason}</span>
                          </div>
                          <div class="mono muted">{approval.resource}</div>
                        </div>
                        <Show when={approval.status === 'pending'}>
                          <div class="row-actions">
                            <button
                              type="button"
                              class="text-button primary"
                              onClick={() => props.onApprove(approval.id)}
                            >
                              {props.t('approve')}
                            </button>
                            <button
                              type="button"
                              class="text-button"
                              onClick={() => props.onReject(approval.id)}
                            >
                              {props.t('reject')}
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={task().approvals.length === 0}>
                    <p class="empty-state">{props.t('noApprovalsForTask')}</p>
                  </Show>
                </section>
              </>
            )}
          </Show>
        </section>
      </div>

      <details class="event-panel">
        <summary class="section-heading">
          <span>{props.t('eventStream')}</span>
          <span class="muted num">{props.events.length}</span>
        </summary>
        <For each={props.events.slice(0, 8)}>
          {(raw) => {
            const event = parseEvent(raw)
            return (
              <div class="event-row">
                <span class="mono event-type">{event?.type ?? 'event'}</span>
                <span class="mono muted">
                  {event?.at === '' || event?.at === undefined
                    ? raw.slice(0, 80)
                    : relativeTime(props.locale, event.at)}
                </span>
              </div>
            )
          }}
        </For>
      </details>
    </div>
  )
}
