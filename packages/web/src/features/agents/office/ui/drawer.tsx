import { createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/ui/Icon'
import { type AgentPresence, api, type TaskView } from '../../../../shared/api'
import { formatRelativeTime, type Locale } from '../../../../shared/i18n'
import type { OfficeTranslate } from '../strings'

export interface DrawerProps {
  id: string
  agents: () => AgentPresence[]
  busy: boolean
  error: string
  locale: Locale
  onClose: () => void
  onDecide: (approvalId: string, action: 'approve' | 'reject') => void
  t: OfficeTranslate
}

/**
 * 抽屉：当前执行 / 审批 / 证据 / 权限 / 能力（§3.4）。
 * 审批只调用现有端点，前端不改任务状态；证据复用 GET /tasks/:id。
 */
export function Drawer(props: DrawerProps) {
  const agent = (): AgentPresence | undefined => props.agents().find((item) => item.id === props.id)
  const [task, setTask] = createSignal<TaskView>()
  const [evidenceError, setEvidenceError] = createSignal('')

  onSettled(() => {
    const taskId = agent()?.activity?.taskId
    if (taskId === undefined) return
    let cancelled = false
    void api
      .task(taskId)
      .then((value) => {
        if (!cancelled) setTask(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setEvidenceError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  })

  return (
    <Show when={agent()}>
      {(current) => (
        <aside class="pointer-events-auto absolute inset-y-4 right-4 z-30 flex w-80 flex-col overflow-hidden rounded-panel border border-line-strong bg-surface shadow-dialog">
          <header class="flex items-start gap-2.5 border-b border-line px-3.5 py-3">
            <div class="min-w-0">
              <h2 class="truncate text-section text-ink">{current().name}</h2>
              <p class="mt-0.5 truncate font-mono text-badge text-ink-3">{current().id}</p>
            </div>
            <button
              type="button"
              class="ml-auto grid size-6 shrink-0 place-items-center rounded-control border border-line text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label={props.t('close')}
              onClick={() => props.onClose()}
            >
              <Icon name="x" size={14} />
            </button>
          </header>

          <div class="flex flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
            {/* 当前执行 */}
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-badge tracking-wide text-ink-3 uppercase">
                {props.t('taskLabel')}
              </h3>
              <Show
                when={current().activity}
                fallback={<p class="text-meta text-ink-2">{props.t('noActivity')}</p>}
              >
                {(activity) => (
                  <div class="rounded-control border border-line bg-subtle px-2.5 py-2">
                    <p class="text-meta font-semibold text-ink">
                      {activity().taskTitle === ''
                        ? props.t('waitingDispatch')
                        : activity().taskTitle}
                    </p>
                    <p class="mt-1 font-mono text-badge text-ink-2">
                      {activity().subtaskTitle === ''
                        ? props.t('noSubtask')
                        : activity().subtaskTitle}
                    </p>
                    <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-badge text-ink-3">
                      <Show when={activity().step !== undefined && activity().steps !== undefined}>
                        <span>{props.t('stepLabel')}</span>
                        <span class="text-right text-ink-2">
                          {props.t('stepOf', {
                            step: activity().step ?? 0,
                            steps: activity().steps ?? 0,
                          })}
                        </span>
                      </Show>
                      <span>{props.t('attemptLabel')}</span>
                      <span class="text-right text-ink-2">{activity().attempt}</span>
                      <Show when={current().parallelCount > 0}>
                        <span>{props.t('parallelLabel')}</span>
                        <span class="text-right text-ink-2">+{current().parallelCount}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </section>

            {/* 审批 */}
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-badge tracking-wide text-ink-3 uppercase">
                {props.t('approvalsLabel')}
              </h3>
              <Show
                when={current().pendingApprovals.length > 0}
                fallback={<p class="text-meta text-ink-2">{props.t('noApprovals')}</p>}
              >
                <For each={current().pendingApprovals}>
                  {(approval) => (
                    <div class="rounded-control border border-warning bg-warning-soft px-2.5 py-2">
                      <p class="font-mono text-badge text-ink-2">{approval.resource}</p>
                      <p class="mt-1 text-badge text-ink-3">
                        {approval.riskLevel} ·{' '}
                        {formatRelativeTime(props.locale, approval.requestedAt)}
                      </p>
                      <div class="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={props.busy}
                          onClick={() => props.onDecide(approval.id, 'approve')}
                        >
                          {props.t('allowOnce')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          disabled={props.busy}
                          onClick={() => props.onDecide(approval.id, 'reject')}
                        >
                          {props.t('reject')}
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={props.error !== ''}>
                <p class="text-badge text-danger" role="alert">
                  {props.t('approvalFailed')} {props.error}
                </p>
              </Show>
            </section>

            {/* 证据 */}
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-badge tracking-wide text-ink-3 uppercase">
                {props.t('evidenceLabel')}
              </h3>
              <Show
                when={current().activity?.taskId !== undefined}
                fallback={<p class="text-meta text-ink-2">{props.t('noEvidence')}</p>}
              >
                <Show
                  when={task()}
                  fallback={
                    <p class="text-badge text-ink-3">
                      {evidenceError() === '' ? '…' : evidenceError()}
                    </p>
                  }
                >
                  {(evidence) => (
                    <div class="grid grid-cols-3 gap-2">
                      <Metric label={props.t('plan')} value={evidence().subtasks.length} />
                      <Metric label={props.t('execution')} value={evidence().executions.length} />
                      <Metric
                        label={props.t('verification')}
                        value={evidence().verifications.length}
                      />
                    </div>
                  )}
                </Show>
                <a
                  class="text-badge text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  href={`/tasks/${current().activity?.taskId ?? ''}`}
                >
                  {props.t('viewTask')} →
                </a>
              </Show>
            </section>

            {/* 权限 / 能力 */}
            <section class="flex flex-col gap-1.5">
              <h3 class="font-mono text-badge tracking-wide text-ink-3 uppercase">
                {props.t('capabilitiesLabel')}
              </h3>
              <Show
                when={current().capabilities.length > 0}
                fallback={<p class="text-badge text-ink-3">{props.t('noneShort')}</p>}
              >
                <div class="flex flex-wrap gap-1">
                  <For each={current().capabilities}>
                    {(capability) => (
                      <span class="rounded-control bg-subtle px-1.5 py-0.5 font-mono text-badge text-ink-2">
                        {capability}
                      </span>
                    )}
                  </For>
                </div>
                <p class="text-badge text-ink-3">{props.t('unverified')}</p>
              </Show>
              <Facts
                rows={[
                  [props.t('networkLabel'), current().networkMode],
                  [
                    props.t('writeScopeLabel'),
                    current().allowedWrite.length > 0
                      ? current().allowedWrite.join(', ')
                      : props.t('noneShort'),
                  ],
                  [
                    props.t('domainsLabel'),
                    current().allowedDomains.length > 0
                      ? current().allowedDomains.join(', ')
                      : props.t('noneShort'),
                  ],
                  [
                    props.t('lastSeenLabel'),
                    current().lastSeenAt === undefined
                      ? props.t('noneShort')
                      : formatRelativeTime(props.locale, current().lastSeenAt ?? ''),
                  ],
                  [
                    props.t('lastEventLabel'),
                    current().lastEvent === undefined
                      ? props.t('noneShort')
                      : `${current().lastEvent?.type ?? ''} · ${formatRelativeTime(
                          props.locale,
                          current().lastEvent?.at ?? '',
                        )}`,
                  ],
                ]}
              />
            </section>
          </div>
        </aside>
      )}
    </Show>
  )
}

function Metric(props: { label: string; value: number }) {
  return (
    <div class="rounded-control border border-line bg-surface px-2 py-1.5 text-center">
      <div class="font-mono text-meta text-ink">{props.value}</div>
      <div class="truncate font-mono text-badge text-ink-3">{props.label}</div>
    </div>
  )
}

function Facts(props: { rows: Array<[string, string]> }) {
  return (
    <dl class="mt-1 flex flex-col gap-1">
      <For each={props.rows}>
        {([label, value]) => (
          <div class="flex items-start justify-between gap-3 text-badge">
            <dt class="shrink-0 text-ink-3">{label}</dt>
            <dd class="min-w-0 truncate text-right text-ink-2">{value}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}
