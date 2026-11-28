import type { LucideIcon } from '@lucide/solid'
import Activity from '@lucide/solid/icons/activity'
import Archive from '@lucide/solid/icons/archive'
import ArrowLeft from '@lucide/solid/icons/arrow-left'
import ArrowUp from '@lucide/solid/icons/arrow-up'
import Bot from '@lucide/solid/icons/bot'
import Check from '@lucide/solid/icons/check'
import ChevronDown from '@lucide/solid/icons/chevron-down'
import ChevronLeft from '@lucide/solid/icons/chevron-left'
import ChevronRight from '@lucide/solid/icons/chevron-right'
import ClipboardCheck from '@lucide/solid/icons/clipboard-check'
import Clock from '@lucide/solid/icons/clock'
import Copy from '@lucide/solid/icons/copy'
import Ellipsis from '@lucide/solid/icons/ellipsis'
import ExternalLink from '@lucide/solid/icons/external-link'
import Eye from '@lucide/solid/icons/eye'
import EyeOff from '@lucide/solid/icons/eye-off'
import FileCode from '@lucide/solid/icons/file-code'
import Folder from '@lucide/solid/icons/folder'
import Globe from '@lucide/solid/icons/globe'
import KeyRound from '@lucide/solid/icons/key-round'
import ListTodo from '@lucide/solid/icons/list-todo'
import MessageSquare from '@lucide/solid/icons/message-square'
import Monitor from '@lucide/solid/icons/monitor'
import Moon from '@lucide/solid/icons/moon'
import PanelLeft from '@lucide/solid/icons/panel-left'
import PanelRight from '@lucide/solid/icons/panel-right'
import Pencil from '@lucide/solid/icons/pencil'
import Play from '@lucide/solid/icons/play'
import Plug from '@lucide/solid/icons/plug'
import Plus from '@lucide/solid/icons/plus'
import RefreshCw from '@lucide/solid/icons/refresh-cw'
import Search from '@lucide/solid/icons/search'
import Settings from '@lucide/solid/icons/settings'
import ShieldCheck from '@lucide/solid/icons/shield-check'
import SquareTerminal from '@lucide/solid/icons/square-terminal'
import Sun from '@lucide/solid/icons/sun'
import Trash2 from '@lucide/solid/icons/trash'
import TriangleAlert from '@lucide/solid/icons/triangle-exclamation-point'
import Wrench from '@lucide/solid/icons/wrench'
import X from '@lucide/solid/icons/x'
import { Dynamic } from '@solidjs/web'

/**
 * The single icon surface for the console.
 *
 * Icons come from `@lucide/solid` — one family, one stroke weight, one grid.
 * Imports are deep (`icons/<name>`) rather than the package barrel so that only
 * the glyphs we use end up in the bundle. Call sites keep using semantic names
 * (`'settings'`, `'trash'`) instead of Lucide's component names, so swapping a
 * glyph is a one-line change here.
 */
export type IconName =
  | 'activity'
  | 'agents'
  | 'alert'
  | 'approvals'
  | 'archive'
  | 'arrowLeft'
  | 'arrowUp'
  | 'check'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'clock'
  | 'copy'
  | 'edit'
  | 'external'
  | 'eye'
  | 'eyeOff'
  | 'file'
  | 'folder'
  | 'globe'
  | 'key'
  | 'message'
  | 'monitor'
  | 'moon'
  | 'more'
  | 'panelLeft'
  | 'panelRight'
  | 'play'
  | 'plug'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'shield'
  | 'sun'
  | 'tasks'
  | 'terminal'
  | 'tool'
  | 'trash'
  | 'x'

const icons: Record<IconName, LucideIcon> = {
  activity: Activity,
  agents: Bot,
  alert: TriangleAlert,
  approvals: ClipboardCheck,
  archive: Archive,
  arrowLeft: ArrowLeft,
  arrowUp: ArrowUp,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  clock: Clock,
  copy: Copy,
  edit: Pencil,
  external: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
  file: FileCode,
  folder: Folder,
  globe: Globe,
  key: KeyRound,
  message: MessageSquare,
  monitor: Monitor,
  moon: Moon,
  more: Ellipsis,
  panelLeft: PanelLeft,
  panelRight: PanelRight,
  play: Play,
  plug: Plug,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  shield: ShieldCheck,
  sun: Sun,
  tasks: ListTodo,
  terminal: SquareTerminal,
  tool: Wrench,
  trash: Trash2,
  x: X,
}

export interface IconProps {
  name: IconName
  size?: number
  class?: string
  label?: string
}

export function Icon(props: IconProps) {
  return (
    <Dynamic
      component={icons[props.name]}
      size={props.size ?? 16}
      /* Lucide defaults to 2; 1.6 keeps the rail as light as the old hand-drawn set. */
      strokeWidth={1.6}
      class={props.class}
      aria-hidden={props.label === undefined ? 'true' : undefined}
      role={props.label === undefined ? undefined : 'img'}
      aria-label={props.label}
    />
  )
}
