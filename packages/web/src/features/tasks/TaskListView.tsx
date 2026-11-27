import { createMemo, createSignal, For, Show } from 'solid-js'
import type { ApprovalRow, TaskRow } from '../../shared/api'
import { relativeTime } from '../../shared/format'
import { type Locale, statusKey, type Translator } from '../../shared/i18n'

/**
 * 任务列表（P5）。
 *
 * 它不再是「左队列 + 右详情」那种常驻第二栏——注意力的计数已经归 app bar，
 * 再摆一条队列就是同一件事数两遍。这里是**深链入口**：一行一个运行，
 * 点进去才是详情。行规格对齐 §3.8.5：标题 13px/500 + 次行 11px 用 `·` 分隔。
 *
 * 行里只写能核对的事实：状态、缺它不可的待审批数、创建时间。
 * （Agent 数、diffstat 这些要读详情才有，列表接口没给，就不编。）
 */

type Filter = 'all' | 'running' | 'waiting' | 'failed' | 'done'

const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled'])
const WAITING = new Set(['waiting_approval', 'waiting_input', 'waiting'])
const DONE = new Set(['completed', 'succeeded'])

const dotTone: Record<Exclude<Filter, 'all'>, string> = {
  running: 'bg-ink-3',
  waiting: 'bg-accent',
  failed: 'bg-danger',
  done: 'bg-success',
}

const filterRow = 'flex flex-wrap items-center gap-1.5 px-2 pb-2.5'
const chipOn = 'border-line bg-raised font-semibold text-ink'
const chipOff = 'border-transparent text-ink-3 hover:text-ink'

export interface TaskListViewProps {
  tasks: readonly TaskRow[]
  approvals: readonly ApprovalRow[]
  locale: Locale
  t: Translator
}

export function TaskListView(props: TaskListViewProps) {
  const [filter, setFilter] = createSignal<Filter>('all')

  const pendingByTask = createMemo<Map<string, number>>(() => {
    const counts = new Map<string, number>()
    for (const approval of props.approvals) {
      if (approval.status !== 'pending') continue
      counts.set(approval.taskId, (counts.get(approval.taskId) ?? 0) + 1)
    }
    return counts
  })

  const phaseOf = (task: TaskRow): Exclude<Filter, 'all'> => {
    if ((pendingByTask().get(task.id) ?? 0) > 0) return 'waiting'
    if (FAILED.has(task.status)) return 'failed'
    if (WAITING.has(task.status)) return 'waiting'
    if (DONE.has(task.status)) return 'done'
    return 'running'
  }

  const counts = createMemo<Record<Exclude<Filter, 'all'>, number>>(() => {
    const value = { running: 0, waiting: 0, failed: 0, done: 0 }
    for (const task of props.tasks) value[phaseOf(task)] += 1
    return value
  })

  const rows = (): TaskRow[] =>
    filter() === 'all' ? [...props.tasks] : props.tasks.filter((task) => phaseOf(task) === filter())

  const filterLabel = (key: Filter): string => {
    const total = props.tasks.length
    if (key === 'all') return props.t('taskFilterAll', { count: total })
    return props.t(
      key === 'running'
        ? 'taskFilterRunning'
        : key === 'waiting'
          ? 'taskFilterWaiting'
          : key === 'failed'
            ? 'taskFilterFailed'
            : 'taskFilterDone',
      { count: counts()[key] },
    )
  }

  return (
    <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-3.5 pb-10 max-[860px]:px-4 max-[860px]:pt-2.5">
      <div class="mx-auto w-full max-w-[720px]">
        <Show when={props.tasks.length > 0}>
          <div class={filterRow}>
            <For each={['all', 'running', 'waiting', 'failed', 'done'] as const}>
              {(key) => (
                <button
                  type="button"
                  class={`h-[26px] rounded-control border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    filter() === key ? chipOn : chipOff
                  }`}
                  aria-pressed={filter() === key ? 'true' : 'false'}
                  onClick={() => setFilter(key)}
                >
                  {filterLabel(key)}
                </button>
              )}
            </For>
          </div>
        </Show>

        <ul class="flex list-none flex-col gap-px p-0">
          <For each={rows()}>
            {(task) => (
              <li>
                <a
                  class="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2 py-2 transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  href={`/tasks/${task.id}`}
                >
                  <span
                    class={`size-[7px] rounded-full ${dotTone[phaseOf(task)]}`}
                    aria-hidden="true"
                  />
                  <span class="min-w-0">
                    <span class="block truncate text-meta font-medium text-ink">{task.title}</span>
                    <span class="mt-0.5 flex flex-wrap items-center gap-1.5 text-badge text-ink-3">
                      <span>{props.t(statusKey(task.status))}</span>
                      <Show when={(pendingByTask().get(task.id) ?? 0) > 0}>
                        <span class="text-line-strong">·</span>
                        <span class="font-medium text-accent">
                          {props.t('pendingCount', { count: pendingByTask().get(task.id) ?? 0 })}
                        </span>
                      </Show>
                    </span>
                  </span>
                  <span class="font-mono text-badge whitespace-nowrap text-ink-3">
                    {relativeTime(props.locale, task.createdAt)}
                  </span>
                </a>
              </li>
            )}
          </For>
        </ul>

        <Show when={props.tasks.length === 0}>
          <p class="rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2">
            {props.t('noTasks')} {props.t('taskEmptyHint')}
          </p>
        </Show>

        <Show when={props.tasks.length > 0 && rows().length === 0}>
          <p class="flex flex-wrap items-center gap-2 px-2 py-4 text-meta text-ink-2">
            {props.t('taskFilterEmpty')}
            <button type="button" class="text-accent" onClick={() => setFilter('all')}>
              {props.t('taskFilterAll', { count: props.tasks.length })}
            </button>
          </p>
        </Show>
      </div>
    </div>
  )
}
