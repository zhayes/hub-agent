import { For, Show } from 'solid-js'
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

export function ApprovalsView(props: ApprovalsViewProps) {
  return (
    <section class="approvals-page" aria-label={props.t('approvals')}>
      <div class="section-heading">
        <span>{props.t('pendingItems')}</span>
      </div>
      <Show
        when={props.approvals.length > 0}
        fallback={<p class="empty-state">{props.t('noApprovals')}</p>}
      >
        <div class="approval-list">
          <For each={props.approvals}>
            {(approval) => (
              <article class={`approval-card${approval.riskLevel === 'high' ? ' risk-high' : ''}`}>
                <div class="approval-card-main">
                  <div class="approval-title">
                    <h2>{approval.reason}</h2>
                    <StatusBadge
                      status={approval.status}
                      label={props.t(statusKey(approval.status))}
                    />
                  </div>
                  <p class="mono approval-resource">{approval.resource}</p>
                  <div class="approval-meta">
                    <a
                      class="meta-link mono"
                      href={`/tasks/${approval.taskId}`}
                      title={approval.taskId}
                    >
                      {shortenId(approval.taskId)}
                    </a>
                    <span aria-hidden="true">·</span>
                    <span>
                      {props.t('risk')} · <span class="risk-level">{approval.riskLevel}</span>
                    </span>
                    <Show when={approval.executionId !== ''}>
                      <span aria-hidden="true">·</span>
                      <span class="mono">{shortenId(approval.executionId)}</span>
                    </Show>
                  </div>
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
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
