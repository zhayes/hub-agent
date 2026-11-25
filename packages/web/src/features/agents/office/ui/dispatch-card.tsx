import { For, Show } from 'solid-js'
import type { AgentPresence } from '../../../../shared/api'
import type { OfficeTranslate } from '../strings'

export interface DispatchCardProps {
  primary: AgentPresence | undefined
  queue: AgentPresence[]
  deskCount: number
  benchCount: number
  unseatedCount: number
  labelOf: (agent: AgentPresence) => string
  onSelect: (agent: AgentPresence) => void
  t: OfficeTranslate
}

/**
 * 调度卡：当前工单 / 计划步骤 / 队列 / 容量（§2.1 调度台）。
 * 只展示真实字段；没有活跃任务就显示「等待派发」，不造假进度。
 */
export function DispatchCard(props: DispatchCardProps) {
  const stepText = (): string => {
    const activity = props.primary?.activity
    if (activity?.step === undefined || activity.steps === undefined) return ''
    return props.t('stepOf', { step: activity.step, steps: activity.steps })
  }

  return (
    <section class="pointer-events-auto absolute top-4 right-4 z-10 w-72 rounded-panel border border-line bg-surface/92 p-3.5 shadow-card backdrop-blur">
      <header class="flex items-baseline justify-between gap-2">
        <h2 class="text-section text-ink">{props.t('dispatch')}</h2>
        <span class="font-mono text-badge text-ink-3">
          {props.t('desksCount', { count: props.deskCount })}
        </span>
      </header>

      <div class="mt-2 flex flex-wrap gap-1.5">
        <span class="rounded-full border border-line px-2 py-0.5 font-mono text-badge text-ink-2">
          {props.t('benchCount', { count: props.benchCount })}
        </span>
        <Show when={props.unseatedCount > 0}>
          <span class="rounded-full border border-warning px-2 py-0.5 font-mono text-badge text-warning">
            {props.t('floorFull', { count: props.unseatedCount })}
          </span>
        </Show>
      </div>

      <Show
        when={props.primary}
        fallback={
          <p class="mt-3 rounded-control border border-dashed border-line-strong px-3 py-2.5 text-meta text-ink-2">
            {props.t('queueEmpty')}
          </p>
        }
      >
        {(primary) => (
          <button
            type="button"
            class="mt-3 block w-full rounded-control border border-dashed border-line bg-subtle px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => props.onSelect(primary())}
          >
            <span class="block font-mono text-badge tracking-wide text-ink-3 uppercase">
              {props.t('taskLabel')} · {primary().name}
            </span>
            <span class="mt-1 block text-meta font-semibold text-ink">
              {primary().activity?.taskTitle ?? props.t('waitingDispatch')}
            </span>
            <span class="mt-1 block truncate font-mono text-badge text-ink-2">
              {primary().activity?.subtaskTitle ?? props.t('noSubtask')}
            </span>
            <Show when={stepText() !== ''}>
              <span class="mt-1 block font-mono text-badge text-ink-3">{stepText()}</span>
            </Show>
          </button>
        )}
      </Show>

      <Show when={props.queue.length > 0}>
        <ul class="mt-2.5 flex flex-col gap-1">
          <For each={props.queue}>
            {(agent) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded-control px-1.5 py-1 text-left text-meta hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={() => props.onSelect(agent)}
                >
                  <span class="truncate font-medium text-ink">{agent.name}</span>
                  <span class="shrink-0 font-mono text-badge text-ink-3">
                    {props.labelOf(agent)}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
