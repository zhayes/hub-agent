import { Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import type { AttentionItem } from '../../shared/attention'
import type { Translator } from '../../shared/i18n'

export interface DecisionBodyProps {
  item: AttentionItem
  t: Translator
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
  /** 队列里还剩几条（不含当前这条）。 */
  remaining?: number
}

const facts = 'mt-3 flex flex-col gap-1 text-meta'
const factRow = 'flex gap-3'
/* 标签列不固定宽度：固定 w-16 会把 “If approved” 折成两行（真实踩到）。 */
const factKey = 'w-[5.5rem] shrink-0 text-ink-3'
const factValue = 'min-w-0 flex-1 text-ink-2'

const riskKey = (risk: string | undefined): 'riskHigh' | 'riskMedium' | 'riskLow' | undefined =>
  risk === 'high'
    ? 'riskHigh'
    : risk === 'medium'
      ? 'riskMedium'
      : risk === 'low'
        ? 'riskLow'
        : undefined

/**
 * 一条待你仲裁的事（v9 §3.7.3）。
 *
 * 五个问题：是什么（标题 + 命令）/ 在哪（任务）/ 为什么 / 允许后 / 拒绝后。
 * 浮层与 dock 共用这一份，避免两处文案各写一遍再漂移。
 * **没有内框、没有竖线、没有「你」徽标**：“轮到你”由容器的琥珀色与实心按钮表达。
 */
export function DecisionBody(props: DecisionBodyProps) {
  const item = props.item
  return (
    <div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 class="min-w-0 flex-1 text-meta font-semibold text-ink">{item.title}</h3>
        <Show when={riskKey(item.risk)}>
          {(key) => <span class="shrink-0 text-badge text-warning">{props.t(key())}</span>}
        </Show>
      </div>

      <Show when={item.resource}>
        {(resource) => (
          <code class="mt-2 block overflow-x-auto rounded-control bg-subtle px-2.5 py-2 font-mono text-badge text-ink-2">
            {resource()}
          </code>
        )}
      </Show>

      <dl class={facts}>
        <Show when={item.taskTitle ?? item.taskId}>
          <div class={factRow}>
            <dt class={factKey}>{props.t('approvalWhere')}</dt>
            <dd class={factValue}>
              <Show when={item.taskId} fallback={<span>{item.taskTitle}</span>}>
                {(taskId) => (
                  <a
                    class="underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    href={`/tasks/${taskId()}`}
                  >
                    {item.taskTitle ?? taskId()}
                  </a>
                )}
              </Show>
            </dd>
          </div>
        </Show>
        <Show when={item.kind === 'approval'}>
          <div class={factRow}>
            <dt class={factKey}>{props.t('ifApprove')}</dt>
            <dd class={factValue}>{props.t('consequenceApprove')}</dd>
          </div>
          <div class={factRow}>
            <dt class={factKey}>{props.t('ifReject')}</dt>
            <dd class={factValue}>{props.t('consequenceReject')}</dd>
          </div>
        </Show>
      </dl>

      <div class="mt-3.5 flex items-center gap-2">
        <Show
          when={item.kind === 'approval'}
          fallback={
            <Show when={item.taskId}>
              {(taskId) => (
                <a
                  class="inline-flex h-8 shrink-0 items-center justify-center rounded-control bg-ink px-3 text-meta font-medium text-canvas transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  href={`/tasks/${taskId()}`}
                >
                  {props.t('openTask')}
                </a>
              )}
            </Show>
          }
        >
          <Button
            variant="primary"
            onClick={() => props.onApprove(item.approvalId ?? '')}
            disabled={item.approvalId === undefined}
          >
            {props.t('approve')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => props.onReject(item.approvalId ?? '')}
            disabled={item.approvalId === undefined}
          >
            {props.t('reject')}
          </Button>
        </Show>
        <span class="flex-1" />
        <Show when={(props.remaining ?? 0) > 0}>
          <span class="text-badge tabular-nums text-ink-3">
            {props.t('approvalRemaining', { count: props.remaining ?? 0 })}
          </span>
        </Show>
      </div>
    </div>
  )
}
