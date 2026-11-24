import { Icon, type IconName } from './Icon'

type Tone = 'running' | 'success' | 'failed' | 'waiting' | 'neutral'

function toneFor(status: string): Tone {
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'completed' || status === 'succeeded' || status === 'pass') return 'success'
  if (status === 'failed' || status === 'error' || status === 'rejected') return 'failed'
  if (status === 'waiting_approval' || status === 'waiting_input' || status === 'paused')
    return 'waiting'
  return 'neutral'
}

function iconFor(status: string): IconName {
  if (status === 'running' || status === 'queued') return 'activity'
  if (status === 'completed' || status === 'succeeded' || status === 'pass') return 'check'
  if (status === 'failed' || status === 'error' || status === 'rejected') return 'x'
  if (status === 'waiting_approval' || status === 'waiting_input' || status === 'paused')
    return 'clock'
  return 'chevronRight'
}

export interface StatusBadgeProps {
  status: string
  label: string
}

export function StatusBadge(props: StatusBadgeProps) {
  return (
    <span class={`status-badge ${toneFor(props.status)}`}>
      <Icon name={iconFor(props.status)} size={12} />
      <span>{props.label}</span>
    </span>
  )
}
