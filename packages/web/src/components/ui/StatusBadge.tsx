export type StatusTone = 'running' | 'success' | 'failed' | 'waiting' | 'neutral'

export function statusTone(status: string): StatusTone {
  if (status === 'running' || status === 'queued' || status === 'active') return 'running'
  if (status === 'online') return 'success'
  if (status === 'needs_auth') return 'waiting'
  if (
    status === 'completed' ||
    status === 'succeeded' ||
    status === 'pass' ||
    status === 'passed' ||
    status === 'verified' ||
    status === 'approved'
  ) {
    return 'success'
  }
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'missing' ||
    status === 'rejected' ||
    status === 'fail' ||
    status === 'blocked'
  ) {
    return 'failed'
  }
  if (
    status === 'waiting_approval' ||
    status === 'waiting_input' ||
    status === 'waiting' ||
    status === 'pending' ||
    status === 'paused'
  ) {
    return 'waiting'
  }
  return 'neutral'
}

const badgeTones: Record<StatusTone, string> = {
  running: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  failed: 'bg-danger-soft text-danger',
  waiting: 'bg-warning-soft text-warning',
  neutral: 'bg-subtle text-ink-2',
}

const dotTones: Record<StatusTone, string> = {
  running: 'bg-accent',
  success: 'bg-success',
  failed: 'bg-danger',
  waiting: 'bg-warning',
  neutral: 'bg-ink-3',
}

/* The legacy `.status-badge` / `.status-dot` rules are gone: colour, size and
   radius all come from utilities, and forced-colors is a variant now. */
const badgeBase =
  'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-badge forced-colors:border forced-colors:border-CanvasText'
const dotBase =
  'inline-block size-[7px] shrink-0 rounded-full forced-colors:[forced-color-adjust:none]'

export interface StatusBadgeProps {
  status: string
  label: string
  class?: string
}

export function StatusBadge(props: StatusBadgeProps) {
  return (
    <span
      class={`${badgeBase} ${badgeTones[statusTone(props.status)]}${props.class === undefined ? '' : ` ${props.class}`}`}
    >
      <span>{props.label}</span>
    </span>
  )
}

export interface ConnectionDotProps {
  state: 'live' | 'connecting' | 'offline'
}

/** The daemon link is not a task status, so it gets its own tone map. */
export function ConnectionDot(props: ConnectionDotProps) {
  const tone = (): string => {
    if (props.state === 'live') return 'bg-success'
    if (props.state === 'connecting') return 'bg-warning'
    return 'bg-ink-3'
  }
  return <span class={`${dotBase} ${tone()}`} aria-hidden="true" />
}

export interface StatusDotProps {
  status: string
  class?: string
}

export function StatusDot(props: StatusDotProps) {
  return (
    <span
      class={`${dotBase} ${dotTones[statusTone(props.status)]}${props.class === undefined ? '' : ` ${props.class}`}`}
      aria-hidden="true"
    />
  )
}
