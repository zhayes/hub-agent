import { Icon, type IconName } from './Icon'

export interface IconButtonProps {
  icon: IconName
  label: string
  onClick?: (event: MouseEvent) => void
  class?: string
  variant?: 'ghost' | 'secondary' | 'primary'
  active?: boolean
  disabled?: boolean
}

export function IconButton(props: IconButtonProps) {
  return (
    <button
      type="button"
      class={`icon-button ${props.variant ?? 'ghost'}${props.active === true ? ' active' : ''}${props.class === undefined ? '' : ` ${props.class}`}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={16} />
    </button>
  )
}
