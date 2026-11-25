import { For, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { ApprovalRow } from '../../shared/api'
import { shortenId } from '../../shared/format'
import { statusKey, type Translator } from '../../shared/i18n'

export interface ApprovalsViewProps {
  approvals: ApprovalRow[]
  t: Translator
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

const page = 'max-w-[880px] pb-6'
const sectionHeading =
  'flex items-baseline justify-between gap-3 pb-2.5 text-meta font-semibold text-ink'
const emptyState =
  'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2 forced-colors:border forced-colors:border-CanvasText'
const list = 'flex flex-col gap-2.5 border-t border-line'
const cardBase =
  'flex items-start justify-between gap-6 rounded-control border bg-surface px-4 py-[14px] forced-colors:border forced-colors:border-CanvasText'
const cardTone = (risk: string): string => (risk === 'high' ? 'border-danger/40' : 'border-line')
const titleRow = 'flex min-w-0 items-center gap-3'
const title = 'm-0 min-w-0 max-w-[46ch] truncate text-section font-semibold text-ink'
const resource = 'mt-1.5 break-words font-mono text-meta tabular-nums text-ink-2'
const meta = 'mt-2 flex flex-wrap items-center gap-1.5 text-meta text-ink-3'
const metaLink =
  'font-mono tabular-nums text-ink-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const monoId = 'font-mono tabular-nums'
const actions = 'flex shrink-0 items-center gap-1'

export function ApprovalsView(props: ApprovalsViewProps) {
  return (
    <section class={page} aria-label={props.t('approvals')}>
      <div class={sectionHeading}>
        <span>{props.t('pendingItems')}</span>
      </div>
      <Show
        when={props.approvals.length > 0}
        fallback={<p class={emptyState}>{props.t('noApprovals')}</p>}
      >
        <div class={list}>
          <For each={props.approvals}>
            {(approval) => (
              <article class={`${cardBase} ${cardTone(approval.riskLevel)}`}>
                <div class="min-w-0">
                  <div class={titleRow}>
                    <h2 class={title}>{approval.reason}</h2>
                    <StatusBadge
                      status={approval.status}
                      label={props.t(statusKey(approval.status))}
                    />
                  </div>
                  <p class={resource}>{approval.resource}</p>
                  <div class={meta}>
                    <a class={metaLink} href={`/tasks/${approval.taskId}`} title={approval.taskId}>
                      {shortenId(approval.taskId)}
                    </a>
                    <span aria-hidden="true">·</span>
                    <span>
                      {props.t('risk')} · <span class="capitalize">{approval.riskLevel}</span>
                    </span>
                    <Show when={approval.executionId !== ''}>
                      <span aria-hidden="true">·</span>
                      <span class={monoId}>{shortenId(approval.executionId)}</span>
                    </Show>
                  </div>
                </div>
                <Show when={approval.status === 'pending'}>
                  <div class={actions}>
                    <Button
                      variant="primary"
                      size="md"
                      onClick={() => props.onApprove(approval.id)}
                    >
                      {props.t('approve')}
                    </Button>
                    <Button variant="ghost" size="md" onClick={() => props.onReject(approval.id)}>
                      {props.t('reject')}
                    </Button>
                  </div>
                </Show>
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
