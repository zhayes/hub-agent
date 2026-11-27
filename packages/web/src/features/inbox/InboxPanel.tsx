import { createEffect, createSignal, Show } from 'solid-js'
import { Dialog } from '../../components/ui/Dialog'
import type { AttentionItem } from '../../shared/attention'
import type { Translator } from '../../shared/i18n'
import { DecisionBody } from './DecisionBody'

export interface InboxPanelProps {
  open: boolean
  items: AttentionItem[]
  onClose: () => void
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
  t: Translator
}

const leaving = 'pointer-events-none -translate-x-4 opacity-0'

/**
 * 「等你处理」浮层（PLAN-CONSOLE-INTERACTION §4.2、v9 队列）。
 *
 * 一次只呈现一条：三条摊开会把决策顶出屏幕；右上角只报“还剩几条”。
 * 决定后本条左滑出、下一条右滑入；减动效时直接切换。
 */
export function InboxPanel(props: InboxPanelProps) {
  const [done, setDone] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [phase, setPhase] = createSignal<'idle' | 'out'>('idle')

  /* 每次打开都是新的判断现场：上一轮已处理的不该继续被记住。 */
  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        setDone(new Set<string>())
        setPhase('idle')
      }
    },
  )

  const queue = (): AttentionItem[] => props.items.filter((item) => !done().has(item.id))
  const current = (): AttentionItem | undefined => queue()[0]

  const resolve = (item: AttentionItem, action: 'approve' | 'reject'): void => {
    if (item.approvalId === undefined) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setPhase('out')
    window.setTimeout(
      () => {
        setDone((previous) => new Set([...previous, item.id]))
        setPhase('idle')
      },
      reduce ? 0 : 160,
    )
    if (action === 'approve') props.onApprove(item.approvalId)
    else props.onReject(item.approvalId)
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.t('inboxTitle')}
      closeLabel={props.t('close')}
    >
      <Show
        when={current()}
        keyed
        fallback={<p class="py-2 text-meta text-ink-2">{props.t('attentionClear')}</p>}
      >
        {(item) => (
          <div
            class={`hx-slide-in transition-[transform,opacity] duration-[160ms] ease-[var(--ease-out)] ${
              phase() === 'out' ? leaving : ''
            }`}
          >
            <DecisionBody
              item={item}
              t={props.t}
              remaining={queue().length - 1}
              onApprove={() => resolve(item, 'approve')}
              onReject={() => resolve(item, 'reject')}
            />
          </div>
        )}
      </Show>
    </Dialog>
  )
}
