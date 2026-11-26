import { Icon, type IconName } from './Icon'

export interface IconButtonProps {
  icon: IconName
  label: string
  onClick?: (event: MouseEvent) => void
  class?: string
  variant?: 'ghost' | 'secondary' | 'primary'
  /** Toggle state for screen readers; does not change the look. */
  pressed?: boolean
  disabled?: boolean
}

/* 32px hit area on tokens. No component CSS: the whole control is utilities so
   hover/active colours follow the same palette as the rest of the console. */
const base =
  'grid size-8 shrink-0 place-items-center rounded-control transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

const variants: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
  secondary: 'border border-control bg-surface text-ink hover:bg-hover',
  primary: 'bg-ink text-canvas hover:opacity-90',
}

export function IconButton(props: IconButtonProps) {
  const pressed = (): 'true' | 'false' | undefined =>
    props.pressed === undefined ? undefined : props.pressed ? 'true' : 'false'

  return (
    <button
      type="button"
      class={`${base} ${variants[props.variant ?? 'ghost']}${props.class === undefined ? '' : ` ${props.class}`}`}
      aria-label={props.label}
      aria-pressed={pressed()}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={16} />
    </button>
  )
}
