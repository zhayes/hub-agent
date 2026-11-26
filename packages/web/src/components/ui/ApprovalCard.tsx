import Check from '@lucide/solid/icons/check'
import TriangleExclamation from '@lucide/solid/icons/triangle-exclamation-point'
import X from '@lucide/solid/icons/x'
import { Show } from 'solid-js'
import { Button } from './Button'

export type ApprovalRisk = 'low' | 'medium' | 'high'
export type ApprovalState = 'pending' | 'approved' | 'rejected'

export interface ApprovalCardProps {
  title: string
  /** The exact command or resource waiting for a decision. */
  resource: string
  risk?: ApprovalRisk
  state: ApprovalState
  onApprove?: () => void
  onReject?: () => void
}

/** Ported from Beautiful UI's Approval Card (MIT), wired to HubAgent's two actions. */
export function ApprovalCard(props: ApprovalCardProps) {
  const approved = (): boolean => props.state === 'approved'
  const riskTone = (): string => {
    if (props.risk === 'high') return 'bg-danger-soft text-danger'
    if (props.risk === 'low') return 'bg-success-soft text-success'
    return 'bg-warning-soft text-warning'
  }

  return (
    <Show
      when={props.state === 'pending'}
      fallback={
        <div class="flex items-center gap-2.5 rounded-panel border border-line bg-subtle px-4 py-3">
          <Show when={approved()} fallback={<X size={16} class="text-danger" aria-hidden="true" />}>
            <Check size={16} class="text-success" aria-hidden="true" />
          </Show>
          <span class="text-meta font-medium text-ink">{approved() ? 'Approved' : 'Rejected'}</span>
          <span class="min-w-0 truncate font-mono text-meta text-ink-3">{props.resource}</span>
        </div>
      }
    >
      <article class="overflow-hidden rounded-panel border border-line-strong bg-surface shadow-card">
        <div class="flex items-start gap-3 p-4">
          <span
            class={`mt-px grid size-7 shrink-0 place-items-center rounded-control ${riskTone()}`}
          >
            <TriangleExclamation size={15} aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h3 class="text-body font-semibold leading-snug text-ink">{props.title}</h3>
              <Show when={props.risk !== undefined}>
                <span class={`shrink-0 rounded px-1.5 py-0.5 text-badge capitalize ${riskTone()}`}>
                  {props.risk}
                </span>
              </Show>
            </div>
            <p class="mt-1 break-all font-mono text-meta text-ink-2">{props.resource}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 border-t border-line bg-canvas/70 px-4 py-2.5">
          <Button onClick={() => props.onApprove?.()}>Approve</Button>
          <Button variant="ghost" onClick={() => props.onReject?.()}>
            Reject
          </Button>
        </div>
      </article>
    </Show>
  )
}
