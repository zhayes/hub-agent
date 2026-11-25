import type { JSX } from '@solidjs/web'
import { TabsList, TabsPanel, Tabs as TabsRoot, TabsTab } from '@ui-sdk/solid/tabs'

/** Recessed track, raised thumb: canvas for the list, surface for the selected tab. */
const listClass =
  'inline-flex items-center gap-0.5 rounded-control border border-line bg-canvas p-1'

const tabClass =
  'inline-flex h-7 items-center rounded-control px-2.5 text-meta text-ink-2 transition-colors hover:text-ink disabled:opacity-45 aria-selected:bg-surface aria-selected:text-ink aria-selected:shadow-[0_1px_2px_rgb(0_0_0/0.1)]'

export interface TabsProps {
  defaultValue?: string
  value?: string
  onValueChange?: (value: string | null) => void
  orientation?: 'horizontal' | 'vertical'
  children?: JSX.Element
}

export function Tabs(props: TabsProps) {
  return (
    <TabsRoot
      defaultValue={props.defaultValue}
      value={props.value}
      onValueChange={props.onValueChange}
      orientation={props.orientation}
    >
      {props.children}
    </TabsRoot>
  )
}

export interface TabListProps {
  /** Tabs need a name: "Settings sections", not "Tabs". */
  label: string
  class?: string
  children?: JSX.Element
}

export function TabList(props: TabListProps) {
  return (
    <TabsList
      aria-label={props.label}
      class={`${listClass}${props.class === undefined ? '' : ` ${props.class}`}`}
    >
      {props.children}
    </TabsList>
  )
}

export interface TabProps {
  value: string
  disabled?: boolean
  children?: JSX.Element
}

export function Tab(props: TabProps) {
  return (
    <TabsTab value={props.value} disabled={props.disabled} class={tabClass}>
      {props.children}
    </TabsTab>
  )
}

export interface TabPanelProps {
  value: string
  children?: JSX.Element
}

export function TabPanel(props: TabPanelProps) {
  return (
    <TabsPanel value={props.value} class="mt-3 text-body text-ink-2">
      {props.children}
    </TabsPanel>
  )
}
