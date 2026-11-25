import { Icon } from '../../../../components/ui/Icon'

export interface AttentionBannerProps {
  visible: boolean
  message: string
  hint: string
  onJump: () => void
}

const bannerBase =
  'pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-warning bg-warning-soft px-3.5 py-2 text-meta text-ink shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** 全局等待/故障提示（§2.4）：默认不响铃；点击或用 N 跳到下一个。 */
export function AttentionBanner(props: AttentionBannerProps) {
  return (
    <button
      type="button"
      class={[bannerBase, { hidden: !props.visible }]}
      onClick={() => props.onJump()}
    >
      <Icon name="alert" size={15} />
      <span class="font-medium">{props.message}</span>
      <span class="rounded-control bg-warning/20 px-1.5 py-0.5 font-mono text-badge text-ink">
        {props.hint}
      </span>
    </button>
  )
}
