import type { JSX } from '@solidjs/web'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
export type ButtonSize = 'sm' | 'md'

const base =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-meta',
  md: 'h-8 px-3 text-meta',
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-canvas hover:opacity-90',
  secondary: 'border border-control bg-surface text-ink hover:bg-hover',
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'bg-danger text-canvas hover:opacity-90',
  /* Destructive row action: reads as danger without a filled red button. */
  'danger-ghost': 'text-danger hover:bg-danger-soft hover:text-danger',
}

export interface ButtonProps {
  children?: JSX.Element
  variant?: ButtonVariant
  size?: ButtonSize
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  class?: string
  title?: string
  'aria-label'?: string
  onClick?: (event: MouseEvent) => void
}

/**
 * The button recipe, for the two cases where a real `<button>` is not allowed:
 * links that look like buttons (`<a href>`), and SDK parts that own the element
 * but accept a class (`DialogTrigger`, `DialogClose`). Everything else uses
 * `<Button>`, so there is exactly one definition of what a button looks like.
 */
export interface ButtonClassOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  class?: string
}

export function buttonClass(options: ButtonClassOptions = {}): string {
  const variant = options.variant ?? 'primary'
  const size = options.size ?? 'md'
  return `${base} ${sizes[size]} ${variants[variant]}${options.class === undefined ? '' : ` ${options.class}`}`
}

export function Button(props: ButtonProps) {
  return (
    <button
      type={props.type ?? 'button'}
      class={buttonClass({ variant: props.variant, size: props.size, class: props.class })}
      disabled={props.disabled}
      title={props.title}
      aria-label={props['aria-label']}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
