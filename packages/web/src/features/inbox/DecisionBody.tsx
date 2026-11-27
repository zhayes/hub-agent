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

/** 领域动作 → 一句“你被要求做什么”（v9 §3.7.3）。 */
function actionTitle(action: string | undefined, t: Translator): string | undefined {
  if (action === 'sandbox.relax') return t('approvalActionSandbox')
  return undefined
}

/** 过期时间 → “58 分钟后过期”。已过期不再报价，直接说已过期。 */
function expiryText(expiresAt: string | undefined, t: Translator): string | undefined {
  if (expiresAt === undefined) return undefined
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return undefined
  const minutes = Math.round((at - Date.now()) / 60_000)
  if (minutes <= 0) return t('expired')
  return minutes < 60
    ? t('expiresInMinutes', { minutes })
    : t('expiresInHours', { hours: Math.round(minutes / 60) })
}

/**
 * 一条待你仲裁的事（v9 §3.7.3）。
 *
 * 五个问题：是什么（动作 + 命令）/ 为什么 / 允许后 / 拒绝后 / 什么时候过期。
 * 浮层与 dock 共用这一份，避免两处文案各写一遍再漂移。
 * **没有内框、没有竖线、没有「你」徽标**：“轮到你”由容器的琥珀色与实心按钮表达。
 */
export function DecisionBody(props: DecisionBodyProps) {
  const item = props.item
  const title = (): string => actionTitle(item.action, props.t) ?? item.title
  const meta = (): string => {
    const expiry = expiryText(item.expiresAt, props.t)
    const risk = riskKey(item.risk)
    const riskLabel = risk === undefined ? undefined : props.t(risk)
    return [expiry, riskLabel].filter((part) => part !== undefined).join(' · ')
  }
  const allowLabel = (): string =>
    item.decisionMode === 'policy'
      ? props.t('approve')
      : item.action === 'sandbox.relax'
        ? props.t('allowOnce')
        : props.t('approve')

  return (
    <div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 class="min-w-0 flex-1 text-meta font-semibold text-ink">{title()}</h3>
        <Show when={meta() !== ''}>
          <span class="shrink-0 text-badge text-ink-3">{meta()}</span>
        </Show>
      </div>

      {/* 命令块比卡片更深一层（v9 `.cmd`：canvas 底 + 1px 边），暗色下才不会 “卡片套卡片”。 */}
      <Show when={item.resource}>
        {(resource) => (
          <code class="mt-2 block overflow-x-auto rounded-[8px] border border-line bg-canvas px-2.5 py-[7px] font-mono text-badge text-ink">
            {resource()}
          </code>
        )}
      </Show>

      <dl class={facts}>
        <Show when={item.kind === 'approval'}>
          <div class={factRow}>
            <dt class={factKey}>{props.t('approvalWhy')}</dt>
            <dd class={factValue}>{item.title}</dd>
          </div>
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
            {allowLabel()}
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
