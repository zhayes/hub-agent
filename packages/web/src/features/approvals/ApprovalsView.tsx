import { For, Show } from 'solid-js'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { ApprovalRow } from '../../shared/api'
import { statusKey, type Translator } from '../../shared/i18n'

export interface ApprovalsViewProps {
  approvals: ApprovalRow[]
  t: Translator
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

export function ApprovalsView(props: ApprovalsViewProps) {
  return (
    <section class="table-panel" aria-label={props.t('approvals')}>
      <div class="section-heading">
        <span>{props.t('approvals')}</span>
        <span class="muted num">{props.approvals.length}</span>
      </div>
      <Show
        when={props.approvals.length > 0}
        fallback={<p class="empty-state">{props.t('noApprovals')}</p>}
      >
        <div class="approval-list">
          <For each={props.approvals}>
            {(approval) => (
              <div class="approval-queue-row">
                <div class="approval-queue-main">
                  <div class="approval-title">
                    <StatusBadge
                      status={approval.status}
                      label={props.t(statusKey(approval.status))}
                    />
                    <span class="mono">{approval.reason}</span>
                  </div>
                  <div class="mono muted">{approval.resource}</div>
                  <div class="mono muted">{approval.taskId}</div>
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
        </div>
      </Show>
    </section>
  )
}
