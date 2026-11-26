import type { JSX } from '@solidjs/web'
import { Icon } from './Icon'

export interface ThinkingTraceProps {
  /** Disclosure label, e.g. "Plan". Already translated by the caller. */
  title: string
  summary?: string
  /** Extra line under the label, e.g. the step count. */
  meta?: string
  /** 失败/需要用户处理时默认展开；其余保持折叠。 */
  open?: boolean
  children?: JSX.Element
}

/**
 * Collapsible reasoning block. The hub does not emit chain-of-thought, so this
 * shows the plan the runtime actually persists — collapsed by default because
 * the outcome matters more than the steps for a finished thread.
 */
export function ThinkingTrace(props: ThinkingTraceProps) {
  return (
    <details class="group rounded-panel border border-line bg-canvas" open={props.open}>
      <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-meta font-medium text-ink [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevronRight"
          size={12}
          class="text-ink-3 transition-transform group-open:rotate-90"
        />
        <span class="shrink-0 whitespace-nowrap">{props.title}</span>
        {props.meta === undefined ? null : (
          <span class="shrink-0 text-badge font-normal text-ink-3">{props.meta}</span>
        )}
        {props.summary === undefined ? null : (
          <span class="ml-1 min-w-0 flex-1 truncate text-badge font-normal text-ink-3">
            {props.summary}
          </span>
        )}
      </summary>
      <div class="border-t border-line px-3 py-2.5 text-meta leading-relaxed text-ink-2">
        {props.children}
      </div>
    </details>
  )
}
