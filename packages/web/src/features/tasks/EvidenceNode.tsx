import type { JSX } from '@solidjs/web'
import { createSignal, Show } from 'solid-js'
import { Icon } from '../../components/ui/Icon'

/**
 * 证据脊柱上的一个节点（P5）。
 *
 * 任务页不再是把六张表平铺，而是一条竖向时间线：计划 → 执行 → 验收，
 * 「为什么 / 事件」压到末端的「记录」里。节点标记用颜色承载状态：
 * 灰=已发生、深=正在跑、红=失败、琥珀=等你、空心=还没到。
 *
 * 连接线是一条 1px 中性线，画到下一个节点里（`:last-child` 不画），
 * 标记用一圈画布色 ring 在线“上打孔”，所以线不会穿过圆点。
 */

export type NodeState = 'done' | 'active' | 'failed' | 'waiting' | 'todo'

const markTone: Record<NodeState, string> = {
  done: 'bg-ink-3',
  active: 'bg-ink',
  failed: 'bg-danger',
  waiting: 'bg-accent',
  todo: 'border-[1.5px] border-control bg-canvas',
}

export interface EvidenceNodeProps {
  state: NodeState
  title: string
  meta?: string
  /** 次级节点（记录）：标题退一档，不跟三个阶段抢注意力。 */
  quiet?: boolean
  /** 初始是否展开。 */
  open?: boolean
  /** false = 不给箭头，内容常驻（「需要你」就是这种）。 */
  collapsible?: boolean
  /** 最后一个节点不画连接线。 */
  last?: boolean
  children?: JSX.Element
}

export function EvidenceNode(props: EvidenceNodeProps) {
  const [open, setOpen] = createSignal(props.open ?? true)

  const collapsible = (): boolean => props.collapsible !== false
  const expanded = (): boolean => !collapsible() || open()
  const titleTone = (): string =>
    props.state === 'waiting' ? 'text-accent' : props.quiet === true ? 'text-ink-2' : 'text-ink'

  return (
    <li class="relative pl-7">
      <span class="absolute top-1 left-0 grid size-[18px] place-items-center" aria-hidden="true">
        <span class={`size-[9px] rounded-full ring-4 ring-canvas ${markTone[props.state]}`} />
      </span>
      <Show when={props.last !== true}>
        <span
          class="absolute top-[21px] -bottom-6 left-[8.5px] w-px bg-line-strong"
          aria-hidden="true"
        />
      </Show>

      <Show
        when={collapsible()}
        fallback={
          <>
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5">
              <span class={`text-meta font-medium ${titleTone()}`}>{props.title}</span>
              <Show when={props.meta !== undefined && props.meta !== ''}>
                <span class="text-badge text-ink-3">{props.meta}</span>
              </Show>
            </div>
            {/* 常驻展开的节点不套内边距容器：内容自己带间距，空内容就什么都不占 */}
            {props.children}
          </>
        }
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-control py-0.5 text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={expanded() ? 'true' : 'false'}
          onClick={() => setOpen((value) => !value)}
        >
          <span class={`shrink-0 text-meta font-medium ${titleTone()}`}>{props.title}</span>
          <Show when={props.meta !== undefined && props.meta !== ''}>
            <span class="min-w-0 truncate text-badge text-ink-3">{props.meta}</span>
          </Show>
          <span class="flex-1" />
          <span class="grid size-[18px] shrink-0 place-items-center text-ink-3">
            <Icon
              name="chevronRight"
              size={11}
              class={`transition-transform duration-150 ${expanded() ? 'rotate-90' : ''}`}
            />
          </span>
        </button>
      </Show>

      {/* 可折叠节点：箭头控制内容；常驻节点（collapsible=false）的内容已在上面渲染，这里不能再画一遍。 */}
      <Show when={collapsible() && expanded()}>
        <div class="pt-1 pb-4">{props.children}</div>
      </Show>
    </li>
  )
}
