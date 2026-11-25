import { For, Show } from 'solid-js'
import { Icon } from '../../components/ui/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { StatusBadge, StatusDot } from '../../components/ui/StatusBadge'
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

type StageState = 'done' | 'active' | 'failed' | 'todo'

interface Stage {
  key: string
  label: string
  meta: string
  state: StageState
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
  const pending = (): ApprovalRow[] =>
    props.selected?.approvals.filter((approval) => approval.status === 'pending') ?? []

  const stages = (): Stage[] => {
    const view = props.selected
    if (view === undefined) return []
    const plan: StageState =
      view.executions.length > 0 ||
      (view.subtasks.length > 0 && view.subtasks.every((subtask) => subtask.status === 'completed'))
        ? 'done'
        : view.subtasks.length === 0
          ? 'todo'
          : 'active'
    const runFailed = view.executions.some((execution) => execution.status === 'failed')
    const runRunning = view.executions.some((execution) => execution.status === 'running')
    const runDone = view.executions.some(
      (execution) => execution.status === 'completed' || execution.status === 'succeeded',
    )
    const execute: StageState = runRunning
      ? 'active'
      : view.executions.length === 0
        ? 'todo'
        : runFailed && !runDone
          ? 'failed'
          : 'done'
    const checkFailed = view.verifications.some(
      (run) => run.verdict === 'fail' || run.verdict === 'failed',
    )
    const checkPassed = view.verifications.some(
      (run) => run.verdict === 'pass' || run.verdict === 'passed' || run.verdict === 'verified',
    )
    const verify: StageState =
      view.verifications.length === 0
        ? 'todo'
        : checkFailed
          ? 'failed'
          : checkPassed
            ? 'done'
            : 'active'
    const decide: StageState =
      pending().length > 0 || view.task.status === 'waiting_approval'
        ? 'active'
        : props.decisions.length > 0
          ? 'done'
          : 'todo'
    return [
      {
        key: 'plan',
        label: props.t('stepPlan'),
        meta: props.t('stepSubtasks', { count: view.subtasks.length }),
        state: plan,
      },
      {
        key: 'execute',
        label: props.t('stepExecute'),
        meta: props.t('stepRuns', { count: view.executions.length }),
        state: execute,
      },
      {
        key: 'verify',
        label: props.t('stepVerify'),
        meta: props.t('stepChecks', { count: view.verifications.length }),
        state: verify,
      },
      {
        key: 'decide',
        label: props.t('stepDecide'),
        meta: props.t('stepDecisions', { count: props.decisions.length }),
        state: decide,
      },
    ]
  }

  return (
    <div class="tasks-layout">
      <section class="task-queue" aria-label={props.t('tasks')}>
        <div class="queue-head">
          <span class="section-heading-label">{props.t('queue')}</span>
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
                <span class="task-row-main">
                  <span class="task-row-title">{task.title}</span>
                  <span class="task-row-meta">
                    <StatusDot status={task.status} />
                    <span>{statusLabel(props.t, task.status)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(props.locale, task.createdAt)}</span>
                  </span>
                </span>
                <Icon name="chevronRight" size={14} class="row-chevron" />
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
                <div class="detail-title">
                  <div class="detail-meta">
                    <StatusBadge
                      status={task().task.status}
                      label={statusLabel(props.t, task().task.status)}
                    />
                    <span class="mono" title={task().task.id}>
                      {shortenId(task().task.id)}
                    </span>
                  </div>
                  <h2>{task().task.title}</h2>
                  <Show when={task().task.description !== ''}>
                    <p class="detail-description">{task().task.description}</p>
                  </Show>
                </div>
                <IconButton
                  icon="copy"
                  label={props.t('copyTaskId')}
                  onClick={() => void navigator.clipboard?.writeText(task().task.id)}
                />
              </header>

              <Show when={pending().length > 0}>
                <div class="needs-you" role="status">
                  <div class="needs-you-main">
                    <Icon name="alert" size={16} />
                    <div>
                      <strong>{props.t('needsYou')}</strong>
                      <p class="mono muted">{pending()[0].resource}</p>
                    </div>
                  </div>
                  <div class="row-actions">
                    <button
                      type="button"
                      class="solid-button"
                      onClick={() => props.onApprove(pending()[0].id)}
                    >
                      {props.t('approve')}
                    </button>
                    <button
                      type="button"
                      class="text-button"
                      onClick={() => props.onReject(pending()[0].id)}
                    >
                      {props.t('reject')}
                    </button>
                  </div>
                </div>
              </Show>

              <ol class="spine" aria-label={props.t('tasks')}>
                <For each={stages()}>
                  {(stage) => (
                    <li class={`spine-step ${stage.state}`}>
                      <span class="spine-mark" aria-hidden="true" />
                      <span class="spine-copy">
                        <span class="spine-label">{stage.label}</span>
                        <span class="spine-meta">{stage.meta}</span>
                      </span>
                    </li>
                  )}
                </For>
              </ol>

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
                        <span class="subtask-title">{subtask.title}</span>
                      </div>
                    )}
                  </For>
                  <Show when={task().subtasks.length === 0}>
                    <p class="empty-state">{props.t('noSubtasks')}</p>
                  </Show>
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
                        <span class="attempt">
                          {props.t('attempt', { count: execution.attempt })}
                        </span>
                        <StatusBadge
                          status={execution.status}
                          label={statusLabel(props.t, execution.status)}
                        />
                        <span class="mono muted" title={execution.id}>
                          {shortenId(execution.id)}
                        </span>
                      </div>
                      <div class="execution-evidence mono">
                        {execution.evidence?.branch ?? props.t('noBranch')} ·{' '}
                        {execution.evidence?.commitSha?.slice(0, 8) ?? '—'}
                      </div>
                      <Show when={execution.evidence?.diffstat}>
                        <pre class="diffstat">{execution.evidence?.diffstat}</pre>
                      </Show>
                      <Show when={execution.evidence?.transcriptRef}>
                        <div class="mono faint">{execution.evidence?.transcriptRef}</div>
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
                        <span class="attempt">{props.t('verification')}</span>
                        <StatusBadge
                          status={run.verdict}
                          label={statusLabel(props.t, run.verdict)}
                        />
                        <span class="mono muted" title={run.id}>
                          {shortenId(run.id)}
                        </span>
                      </div>
                      <For each={run.checks}>
                        {(check) => (
                          <div class="check-row">
                            <StatusBadge
                              status={check.passed ? 'pass' : 'fail'}
                              label={props.t(check.passed ? 'statusPass' : 'statusFail')}
                            />
                            <span class="mono check-kind">{check.kind}</span>
                            <span class="mono muted check-command">
                              {check.command ?? check.outputRef ?? '—'}
                            </span>
                            <Show when={check.exitCode !== undefined}>
                              <span class="mono faint check-exit">
                                {props.t('commandExit', { code: check.exitCode ?? 0 })}
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
                <Show when={task().verifications.length === 0}>
                  <p class="empty-state">{props.t('noEvidence')}</p>
                </Show>
              </section>

              <section class="detail-section">
                <div class="section-heading">
                  <span>{props.t('decisions')}</span>
                  <span class="muted num">{props.decisions.length}</span>
                </div>
                <For each={props.decisions}>
                  {(decision) => (
                    <div class="decision-row">
                      <div class="decision-head">
                        <span class="decision-type">{decision.type}</span>
                        <time class="faint" datetime={decision.decidedAt}>
                          {absoluteTime(props.locale, decision.decidedAt)}
                        </time>
                      </div>
                      <p>{decision.rationale}</p>
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
                          <span>{approval.reason}</span>
                        </div>
                        <div class="mono muted">{approval.resource}</div>
                      </div>
                      <Show when={approval.status === 'pending'}>
                        <div class="row-actions">
                          <button
                            type="button"
                            class="solid-button"
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

              <details class="event-panel">
                <summary class="section-heading event-summary">
                  <span>{props.t('eventStream')}</span>
                  <span class="muted num">{props.events.length}</span>
                </summary>
                <div class="event-list">
                  <For each={props.events.slice(0, 8)}>
                    {(raw) => {
                      const event = parseEvent(raw)
                      return (
                        <div class="event-row">
                          <span class="mono event-type">{event?.type ?? 'event'}</span>
                          <span class="mono faint">
                            {event?.at === '' || event?.at === undefined
                              ? raw.slice(0, 80)
                              : relativeTime(props.locale, event.at)}
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </details>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}
