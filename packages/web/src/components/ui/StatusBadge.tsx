export type StatusTone = 'running' | 'success' | 'failed' | 'waiting' | 'neutral'

export function statusTone(status: string): StatusTone {
  if (status === 'running' || status === 'queued' || status === 'active') return 'running'
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

/* The legacy class names stay on purpose: `styles.css` still keys layout and
   forced-colors rules off `.status-badge` / `.status-dot`. Colours come from
   tokens, which win because the utilities layer is declared last. P3 removes both. */
const badgeBase =
  'status-badge inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-badge'
const dotBase = 'status-dot inline-block size-[7px] shrink-0 rounded-full'

export interface StatusBadgeProps {
  status: string
  label: string
}

export function StatusBadge(props: StatusBadgeProps) {
  return (
    <span class={`${badgeBase} ${badgeTones[statusTone(props.status)]}`}>
      <span>{props.label}</span>
    </span>
  )
}

export interface StatusDotProps {
  status: string
}

export function StatusDot(props: StatusDotProps) {
  return <span class={`${dotBase} ${dotTones[statusTone(props.status)]}`} aria-hidden="true" />
}
