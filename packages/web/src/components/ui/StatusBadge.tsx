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

export interface StatusBadgeProps {
  status: string
  label: string
}

export function StatusBadge(props: StatusBadgeProps) {
  return (
    <span class={`status-badge tone-${statusTone(props.status)}`}>
      <span>{props.label}</span>
    </span>
  )
}

export interface StatusDotProps {
  status: string
}

export function StatusDot(props: StatusDotProps) {
  return <span class={`status-dot tone-${statusTone(props.status)}`} aria-hidden="true" />
}
