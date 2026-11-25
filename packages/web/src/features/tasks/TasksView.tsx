import { For, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { DiffPatch } from '../../components/ui/DiffPatch'
import { DiffView } from '../../components/ui/DiffView'
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

const sectionHeading =
  'flex items-baseline justify-between gap-3 pb-2 text-meta font-semibold text-ink'
const count = 'text-badge font-normal tabular-nums text-ink-3'
const emptyState =
  'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2'

/** Mark tone per spine state; the outline is what makes "active" read as live. */
const spineMark: Record<StageState, string> = {
  todo: 'border-[1.5px] border-line-strong',
  active: 'border-[1.5px] border-accent bg-accent outline-2 outline-accent-soft outline-offset-2',
  done: 'border-[1.5px] border-ink bg-ink',
  failed: 'border-[1.5px] border-danger bg-danger',
}

const spineLabel: Record<StageState, string> = {
  todo: 'text-ink',
  active: 'text-accent',
  done: 'text-ink-2',
  failed: 'text-danger',
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
    <div class="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] max-[1100px]:grid-cols-[300px_minmax(0,1fr)] max-[860px]:grid-cols-1 max-[860px]:grid-rows-[minmax(140px,32vh)_minmax(0,1fr)]">
      <section
        class="flex min-h-0 flex-col border-r border-line max-[860px]:border-r-0 max-[860px]:border-b"
        aria-label={props.t('tasks')}
      >
        <div class="flex flex-none items-baseline justify-between px-[18px] pt-3 pb-2">
          <span class="text-meta font-semibold text-ink">{props.t('queue')}</span>
          <span class={count}>{props.tasks.length}</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5">
          <For each={props.tasks}>
            {(task) => (
              <button
                type="button"
                class={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-panel px-2.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:border forced-colors:border-CanvasText ${
                  props.selected?.task.id === task.id ? 'bg-active' : 'hover:bg-hover'
                }`}
                onClick={() => props.onSelect(task.id)}
              >
                <span class="flex min-w-0 flex-col gap-1">
                  <span
                    class={`line-clamp-2 text-meta leading-snug ${
                      props.selected?.task.id === task.id
                        ? 'font-semibold text-ink'
                        : 'font-medium text-ink'
                    }`}
                  >
                    {task.title}
                  </span>
                  <span class="flex flex-wrap items-center gap-1.5 text-badge text-ink-3">
                    <StatusDot status={task.status} />
                    <span>{statusLabel(props.t, task.status)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(props.locale, task.createdAt)}</span>
                  </span>
                </span>
                <Icon name="chevronRight" size={14} class="shrink-0 text-ink-3" />
              </button>
            )}
          </For>
          <Show when={props.tasks.length === 0}>
            <p class={emptyState}>{props.t('noTasks')}</p>
          </Show>
        </div>
      </section>

      <section
        class="min-h-0 overflow-y-auto bg-surface px-7 pt-5 pb-10 max-[860px]:p-4"
        aria-live="polite"
      >
        <Show
          when={props.selected}
          fallback={
            <div class="flex min-h-[220px] flex-col items-center justify-center gap-2.5 px-8 py-8 text-center text-meta text-ink-2">
              <Icon name="tasks" size={20} />
              <p>{props.t('selectTask')}</p>
            </div>
          }
        >
          {(task) => (
            <>
              <header class="flex items-start justify-between gap-4 border-b border-line pb-4">
                <div class="min-w-0">
                  <div class="mb-2 flex items-center gap-2.5 text-badge text-ink-3">
                    <StatusBadge
                      status={task().task.status}
                      label={statusLabel(props.t, task().task.status)}
                    />
                    <span class="font-mono" title={task().task.id}>
                      {shortenId(task().task.id)}
                    </span>
                  </div>
                  <h2 class="text-title text-ink">{task().task.title}</h2>
                  <Show when={task().task.description !== ''}>
                    <p class="mt-1.5 max-w-[72ch] text-meta text-ink-2">
                      {task().task.description}
                    </p>
                  </Show>
                </div>
                <IconButton
                  icon="copy"
                  label={props.t('copyTaskId')}
                  onClick={() => void navigator.clipboard?.writeText(task().task.id)}
                />
              </header>

              <Show when={pending().length > 0}>
                <div
                  class="mt-4 flex items-center justify-between gap-4 rounded-panel bg-warning-soft px-3.5 py-3 text-warning max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-2.5"
                  role="status"
                >
                  <div class="flex min-w-0 items-start gap-2.5">
                    <Icon name="alert" size={16} />
                    <div class="min-w-0">
                      <strong class="block text-meta font-semibold">{props.t('needsYou')}</strong>
                      <p class="mt-0.5 break-words font-mono text-badge">{pending()[0].resource}</p>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Button onClick={() => props.onApprove(pending()[0].id)}>
                      {props.t('approve')}
                    </Button>
                    <Button variant="ghost" onClick={() => props.onReject(pending()[0].id)}>
                      {props.t('reject')}
                    </Button>
                  </div>
                </div>
              </Show>

              <ol
                class="mt-[18px] grid list-none grid-cols-4 gap-px overflow-hidden rounded-panel border border-line bg-line p-0 max-[560px]:grid-cols-2"
                aria-label={props.t('tasks')}
              >
                <For each={stages()}>
                  {(stage) => (
                    <li class="flex items-start gap-2.5 bg-canvas px-3.5 py-3">
                      <span
                        class={`mt-1 size-[9px] shrink-0 rounded-full ${spineMark[stage.state]}`}
                        aria-hidden="true"
                      />
                      <span class="min-w-0">
                        <span class={`block text-meta font-medium ${spineLabel[stage.state]}`}>
                          {stage.label}
                        </span>
                        <span class="mt-0.5 block text-badge text-ink-3">{stage.meta}</span>
                      </span>
                    </li>
                  )}
                </For>
              </ol>

              <section class="mt-6">
                <div class={sectionHeading}>
                  <span>{props.t('subtasks')}</span>
                  <span class={count}>{task().subtasks.length}</span>
                </div>
                <div class="border-t border-line">
                  <For each={task().subtasks}>
                    {(subtask) => (
                      <div class="flex items-center gap-3 border-b border-line py-2.5">
                        <StatusBadge
                          status={subtask.status}
                          label={statusLabel(props.t, subtask.status)}
                        />
                        <span class="min-w-0 text-meta text-ink">{subtask.title}</span>
                      </div>
                    )}
                  </For>
                  <Show when={task().subtasks.length === 0}>
                    <p class={emptyState}>{props.t('noSubtasks')}</p>
                  </Show>
                </div>
              </section>

              <section class="mt-6">
                <div class={sectionHeading}>
                  <span>{props.t('executions')}</span>
                  <span class={count}>{task().executions.length}</span>
                </div>
                <For each={task().executions}>
                  {(execution) => (
                    <div class="border-b border-line py-3.5">
                      <div class="flex items-center gap-2.5 text-badge max-[560px]:flex-wrap">
                        <span class="text-meta font-medium text-ink">
                          {props.t('attempt', { count: execution.attempt })}
                        </span>
                        <StatusBadge
                          status={execution.status}
                          label={statusLabel(props.t, execution.status)}
                        />
                        <span class="font-mono text-ink-3" title={execution.id}>
                          {shortenId(execution.id)}
                        </span>
                      </div>
                      <div class="mt-1.5 font-mono text-badge text-ink-2">
                        {execution.evidence?.branch ?? props.t('noBranch')} ·{' '}
                        {execution.evidence?.commitSha?.slice(0, 8) ?? '—'}
                      </div>
                      <Show
                        when={
                          (execution.evidence?.diffstat ?? '') !== '' ||
                          (execution.evidence?.changedFiles?.length ?? 0) > 0
                        }
                      >
                        <DiffView
                          class="mt-2"
                          {...(execution.evidence?.diffstat === undefined
                            ? {}
                            : { stat: execution.evidence.diffstat })}
                          {...(execution.evidence?.changedFiles === undefined
                            ? {}
                            : { files: execution.evidence.changedFiles })}
                        />
                      </Show>
                      <Show when={(execution.evidence?.diff ?? '') !== ''}>
                        <details class="group mt-2">
                          <summary class="flex cursor-pointer items-center gap-2 text-badge text-ink-2 [&::-webkit-details-marker]:hidden">
                            <Icon
                              name="chevronRight"
                              size={11}
                              class="text-ink-3 transition-transform group-open:rotate-90"
                            />
                            <span>{props.t('evidence')}</span>
                          </summary>
                          <DiffPatch
                            class="mt-1.5"
                            patch={execution.evidence?.diff ?? ''}
                            limitLabel={props.t('patchLimit')}
                            {...(execution.evidence?.diffTruncated === undefined
                              ? {}
                              : { truncated: execution.evidence.diffTruncated })}
                          />
                        </details>
                      </Show>
                      <Show when={execution.evidence?.transcriptRef}>
                        <div class="font-mono text-badge text-ink-3">
                          {execution.evidence?.transcriptRef}
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={task().executions.length === 0}>
                  <p class={emptyState}>{props.t('noEvidence')}</p>
                </Show>
              </section>

              <section class="mt-6">
                <div class={sectionHeading}>
                  <span>{props.t('verification')}</span>
                  <span class={count}>{task().verifications.length}</span>
                </div>
                <For each={task().verifications}>
                  {(run) => (
                    <div class="border-b border-line py-3.5">
                      <div class="flex items-center gap-2.5 text-badge max-[560px]:flex-wrap">
                        <span class="text-meta font-medium text-ink">
                          {props.t('verification')}
                        </span>
                        <StatusBadge
                          status={run.verdict}
                          label={statusLabel(props.t, run.verdict)}
                        />
                        <span class="font-mono text-ink-3" title={run.id}>
                          {shortenId(run.id)}
                        </span>
                      </div>
                      <For each={run.checks}>
                        {(check) => (
                          <div class="grid grid-cols-[88px_96px_minmax(0,1fr)_auto] items-center gap-2.5 py-[7px] text-badge max-[560px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[560px]:row-gap-0.5">
                            <StatusBadge
                              status={check.passed ? 'pass' : 'fail'}
                              label={props.t(check.passed ? 'statusPass' : 'statusFail')}
                            />
                            <span class="font-mono text-ink-2">{check.kind}</span>
                            <span class="truncate font-mono text-ink-3 max-[560px]:col-span-full max-[560px]:row-start-2">
                              {check.command ?? check.outputRef ?? '—'}
                            </span>
                            <Show when={check.exitCode !== undefined}>
                              <span class="whitespace-nowrap font-mono text-ink-3">
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
                  <p class={emptyState}>{props.t('noEvidence')}</p>
                </Show>
              </section>

              <section class="mt-6">
                <div class={sectionHeading}>
                  <span>{props.t('decisions')}</span>
                  <span class={count}>{props.decisions.length}</span>
                </div>
                <For each={props.decisions}>
                  {(decision) => (
                    <div class="border-b border-line py-3">
                      <div class="flex items-baseline justify-between gap-3">
                        <span class="text-badge font-semibold text-ink">{decision.type}</span>
                        <time class="text-badge text-ink-3" datetime={decision.decidedAt}>
                          {absoluteTime(props.locale, decision.decidedAt)}
                        </time>
                      </div>
                      <p class="mt-1 max-w-[82ch] text-meta text-ink-2">{decision.rationale}</p>
                    </div>
                  )}
                </For>
                <Show when={props.decisions.length === 0}>
                  <p class={emptyState}>{props.t('noDecisions')}</p>
                </Show>
              </section>

              <section class="mt-6">
                <div class={sectionHeading}>
                  <span>{props.t('approvalItems')}</span>
                  <span class={count}>{task().approvals.length}</span>
                </div>
                <For each={task().approvals}>
                  {(approval) => (
                    <div class="flex items-center justify-between gap-4 border-b border-line py-3">
                      <div class="min-w-0">
                        <div class="flex min-w-0 items-center gap-2.5 text-meta">
                          <StatusBadge
                            status={approval.status}
                            label={approvalLabel(props.t, approval)}
                          />
                          <span class="truncate text-ink">{approval.reason}</span>
                        </div>
                        <div class="mt-0.5 font-mono text-badge text-ink-3">
                          {approval.resource}
                        </div>
                      </div>
                      <Show when={approval.status === 'pending'}>
                        <div class="flex shrink-0 items-center gap-2">
                          <Button onClick={() => props.onApprove(approval.id)}>
                            {props.t('approve')}
                          </Button>
                          <Button variant="ghost" onClick={() => props.onReject(approval.id)}>
                            {props.t('reject')}
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={task().approvals.length === 0}>
                  <p class={emptyState}>{props.t('noApprovalsForTask')}</p>
                </Show>
              </section>

              <details class="group mt-6 border-t border-line">
                <summary class="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 pt-3.5 pb-2 text-meta font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="chevronRight"
                    size={12}
                    class="text-ink-3 transition-transform group-open:rotate-90"
                  />
                  <span>{props.t('eventStream')}</span>
                  <span class={count}>{props.events.length}</span>
                </summary>
                <div class="pb-2">
                  <For each={props.events.slice(0, 8)}>
                    {(raw) => {
                      const event = parseEvent(raw)
                      return (
                        <div class="flex items-baseline justify-between gap-3 py-1.5 text-badge">
                          <span class="font-mono text-ink">{event?.type ?? 'event'}</span>
                          <span class="font-mono text-ink-3">
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
