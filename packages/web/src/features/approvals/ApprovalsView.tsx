import { For, Show } from 'solid-js'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { ApprovalRow } from '../../shared/api'
import { approvalToAttention } from '../../shared/attention'
import { shortenId } from '../../shared/format'
import { statusKey, type Translator } from '../../shared/i18n'
import { DecisionBody } from '../inbox/DecisionBody'

export interface ApprovalsViewProps {
  approvals: ApprovalRow[]
  t: Translator
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

/* 与全站同一条量度：720 居中。 */
const page = 'mx-auto w-full max-w-[720px] pb-6'
const sectionHeading =
  'flex items-baseline justify-between gap-3 pb-3 text-meta font-semibold text-ink'
const emptyState =
  'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2 forced-colors:border forced-colors:border-CanvasText'
const list = 'flex flex-col gap-2.5'
const panel =
  'rounded-panel border border-line bg-surface px-4 py-4 forced-colors:border forced-colors:border-CanvasText'
const settledList = 'flex flex-col border-t border-line'
const settledRow = 'flex items-center gap-3 border-b border-line py-2.5'
const settledReason = 'min-w-0 flex-1 truncate text-meta text-ink-2'
const taskLink =
  'shrink-0 font-mono text-badge tabular-nums text-ink-3 underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * 审批深链页（`/approvals`）。
 *
 * 待批的用 `DecisionBody`——与浮层队列、dock、任务详情页是同一个决策对象，
 * 早就该是同一副样子；这里曾经自绘一套卡片，结果同一个审批在不同页面长得不一样。
 * 已处理的降为只读行：它的用途是回看“当时批了什么”，不再需要动作。
 */
export function ApprovalsView(props: ApprovalsViewProps) {
  const pending = (): ApprovalRow[] => props.approvals.filter((item) => item.status === 'pending')
  const settled = (): ApprovalRow[] => props.approvals.filter((item) => item.status !== 'pending')

  return (
    <section class={page} aria-label={props.t('approvals')}>
      <header class="flex items-baseline justify-between gap-3 pb-3">
        <h1 class="text-section text-ink">{props.t('approvals')}</h1>
      </header>
      <Show
        when={pending().length > 0 || settled().length > 0}
        fallback={<p class={emptyState}>{props.t('noApprovals')}</p>}
      >
        <Show when={pending().length > 0}>
          <div class={sectionHeading}>
            <h2 class="m-0 text-meta font-semibold text-ink">{props.t('pendingItems')}</h2>
            <span class="text-badge tabular-nums text-ink-3">{pending().length}</span>
          </div>
          <div class={list}>
            <For each={pending()}>
              {(approval) => (
                <article class={panel}>
                  <DecisionBody
                    item={approvalToAttention(approval)}
                    t={props.t}
                    onApprove={props.onApprove}
                    onReject={props.onReject}
                  />
                </article>
              )}
            </For>
          </div>
        </Show>

        <Show when={settled().length > 0}>
          <div class="mt-6">
            <div class={sectionHeading}>
              <h2 class="m-0 text-meta font-semibold text-ink">{props.t('recentlyResolved')}</h2>
            </div>
            <ul class={`${settledList} m-0 list-none p-0`}>
              <For each={settled()}>
                {(approval) => (
                  <li class={settledRow}>
                    <span class={settledReason}>{approval.reason}</span>
                    <StatusBadge
                      status={approval.status}
                      label={props.t(statusKey(approval.status))}
                    />
                    <a class={taskLink} href={`/tasks/${approval.taskId}`}>
                      {shortenId(approval.taskId)}
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </Show>
    </section>
  )
}
