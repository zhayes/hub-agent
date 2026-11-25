import { Icon, type IconName } from './Icon'

export interface IconButtonProps {
  icon: IconName
  label: string
  onClick?: (event: MouseEvent) => void
  class?: string
  variant?: 'ghost' | 'secondary' | 'primary'
  active?: boolean
  /** Toggle state for screen readers; does not change the look. */
  pressed?: boolean
  disabled?: boolean
}

export function IconButton(props: IconButtonProps) {
  const pressed = (): 'true' | 'false' | undefined =>
    props.pressed === undefined ? undefined : props.pressed ? 'true' : 'false'

  return (
    <button
      type="button"
      class={`icon-button ${props.variant ?? 'ghost'}${props.active === true ? ' active' : ''}${props.class === undefined ? '' : ` ${props.class}`}`}
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
