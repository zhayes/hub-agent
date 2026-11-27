import type { JSX } from '@solidjs/web'
import { createSignal } from 'solid-js'
import { Icon } from './Icon'

export interface ProcessTraceProps {
  /** 这一段是什么，例如「执行过程」。已经翻译好。 */
  title: string
  /** 「7 步 · 用时 1:12」。状态字样不在这里——那是 dock 的事。 */
  meta?: string
  /** 初始展开；三态默认由调用方决定（在跑展开 / 等你收起 / 跑完收起）。 */
  open?: boolean
  children?: JSX.Element
}

/**
 * 过程流（v8/v9 终稿，PLAN-CONSOLE-INTERACTION §3.5）。
 *
 * - **不画横线**：节奏靠留白与分组空隙，行内状态用 `· 完成` 而不是另起一列。
 * - **箭头在最左**：与步骤的 18px 身份位对齐，整列读起来是一条竖线。
 * - 无卡片、无底色：过程是记录，不该和「要你拍板」抢体积。
 */
export function ProcessTrace(props: ProcessTraceProps) {
  const [open, setOpen] = createSignal(props.open ?? false)
  return (
    <div>
      <button
        type="button"
        class="group/proc flex w-full items-center gap-2 rounded-control py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-expanded={open() ? 'true' : 'false'}
        onClick={() => setOpen(!open())}
      >
        <span class="grid size-[18px] shrink-0 place-items-center text-ink-3" aria-hidden="true">
          <Icon
            name="chevronRight"
            size={11}
            class={`transition-transform duration-150 ${open() ? 'rotate-90' : ''}`}
          />
        </span>
        <span class="shrink-0 text-meta font-medium text-ink-2">{props.title}</span>
        {props.meta === undefined ? null : (
          <span class="shrink-0 text-badge tabular-nums text-ink-3">{props.meta}</span>
        )}
        <span class="flex-1" />
      </button>
      {open() ? <div class="mt-1 pl-[26px]">{props.children}</div> : null}
    </div>
  )
}
