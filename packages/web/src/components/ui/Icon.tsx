import { For } from 'solid-js'

export type IconName =
  | 'activity'
  | 'agents'
  | 'alert'
  | 'approvals'
  | 'arrowUp'
  | 'check'
  | 'clock'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'copy'
  | 'external'
  | 'globe'
  | 'key'
  | 'message'
  | 'monitor'
  | 'moon'
  | 'panelLeft'
  | 'panelRight'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'shield'
  | 'sun'
  | 'tasks'
  | 'x'

const paths: Record<IconName, readonly string[]> = {
  activity: ['M3 12h4l2.5-7 5 14 2.5-7H21'],
  agents: ['M5 5h14v14H5z', 'M9 2v3M15 2v3M8 12h.01M16 12h.01M9 16h6'],
  alert: ['M12 3 2.5 20h19L12 3Z', 'M12 9v4M12 17h.01'],
  arrowUp: ['M12 19V5M6 11l6-6 6 6'],
  approvals: ['M7 3h10l3 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7l3-4Z', 'M8 13l2.5 2.5L16 10'],
  check: ['m5 12 4 4L19 6'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronLeft: ['m15 6-6 6 6 6'],
  chevronRight: ['m9 6 6 6-6 6'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  copy: ['M9 9h11v11H9z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  external: ['M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  globe: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  ],
  key: ['M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1Zm0 0L15 8m0 0 3 3m-3-3 3-3'],
  message: ['M4 5h16v11H8l-4 3V5Z', 'M8 9h8M8 12h5'],
  monitor: ['M3 4h18v13H3zM8 21h8M12 17v4'],
  moon: ['M20.9 13.1A8 8 0 0 1 10.9 3a7 7 0 1 0 10 10.1Z'],
  panelLeft: ['M3 4h18v16H3zM9 4v16M14 9l-3 3 3 3'],
  panelRight: ['M3 4h18v16H3zM15 4v16M10 9l3 3-3 3'],
  play: ['m8 5 10 7-10 7V5Z'],
  plus: ['M12 5v14M5 12h14'],
  refresh: ['M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3'],
  settings: [
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
    'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.9 1.9-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.7v-.08A1.7 1.7 0 0 0 11.2 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.9-1.9.06-.06A1.7 1.7 0 0 0 7.76 15a1.7 1.7 0 0 0-1.56-1.03H6v-2.7h.2A1.7 1.7 0 0 0 7.76 10.2a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.9-1.9.06.06A1.7 1.7 0 0 0 11.2 6.76 1.7 1.7 0 0 0 12.23 5.2V5h2.7v.2a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.9 1.9-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v2.7h-.2A1.7 1.7 0 0 0 19.4 15Z',
  ],
  shield: ['M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3Z', 'm9 12 2 2 4-4'],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  tasks: ['M5 6h14M5 12h14M5 18h9', 'M3 6h.01M3 12h.01M3 18h.01'],
  x: ['M6 6l12 12M18 6 6 18'],
}

export interface IconProps {
  name: IconName
  size?: number
  class?: string
  label?: string
}

export function Icon(props: IconProps) {
  const size = () => props.size ?? 16
  return (
    <svg
      class={props.class}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label === undefined ? 'true' : undefined}
      role={props.label === undefined ? undefined : 'img'}
      aria-label={props.label}
    >
      <For each={paths[props.name]}>{(path) => <path d={path} />}</For>
    </svg>
  )
}
