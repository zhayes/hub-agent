import { For, Show } from 'solid-js'
import { DiffPatch } from '../../components/ui/DiffPatch'
import { parseDiffStat } from '../../components/ui/diff-stat'
import { Icon } from '../../components/ui/Icon'
import { formatDuration } from '../../shared/format'
import { statusKey, type Translator } from '../../shared/i18n'
import { attemptMs, type TaskExecution } from './verdict'

/**
 * 执行节点里的一次尝试。
 *
 * 一级信息是「谁跑的 / 结果 / 改了哪些文件」——不用点开就能看到；
 * 真正的补丁才进 disclosure（它是证据，不是结论）。
 * 失败的那一次要说清为什么失败（归因来自 Runtime，不是让 Agent 自述）。
 */

const failureKeys = {
  protocol: 'taskFailProtocol',
  agent: 'taskFailAgent',
  resource: 'taskFailResource',
  verification: 'taskFailVerification',
  budget: 'taskFailBudget',
} as const

const FAILED = new Set(['failed', 'error'])

export interface TaskAttemptProps {
  execution: TaskExecution
  agentName: string
  t: Translator
  /** 第一次尝试不画上分隔线。 */
  first?: boolean
}

export function TaskAttempt(props: TaskAttemptProps) {
  const failed = (): boolean => FAILED.has(props.execution.status)
  const stateWord = (): string => {
    const category = props.execution.failureCategory
    if (failed() && category !== undefined) return props.t(failureKeys[category])
    return props.t(statusKey(props.execution.status))
  }
  const stateTone = (): string => {
    if (failed()) return 'text-danger'
    if (props.execution.status === 'running') return 'text-ink-2'
    return 'text-success'
  }
  const files = (): string[] => {
    const stat = props.execution.evidence?.diffstat ?? ''
    const parsed = parseDiffStat(stat)
    if (parsed.files.length > 0) return parsed.files.map((file) => file.path)
    return props.execution.evidence?.changedFiles ?? []
  }
  const revision = (): string => {
    const branch = props.execution.evidence?.branch
    const sha = props.execution.evidence?.commitSha?.slice(0, 8)
    if (branch === undefined && sha === undefined) return ''
    return [branch, sha].filter((part) => part !== undefined && part !== '').join(' · ')
  }
  const duration = (): string | undefined => {
    const ms = attemptMs(props.execution)
    return ms === undefined ? undefined : formatDuration(ms)
  }
  const patch = (): string => props.execution.evidence?.diff ?? ''

  return (
    <section class={props.first === true ? '' : 'mt-3 border-t border-line pt-3'}>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-meta font-medium text-ink">
          {props.t('attempt', { count: props.execution.attempt })}
        </span>
        <Show when={props.agentName !== ''}>
          <span class="text-meta text-ink-2">{props.agentName}</span>
        </Show>
        <span class={`text-badge ${stateTone()}`}>{stateWord()}</span>
        <Show when={revision() !== ''}>
          <span
            class="min-w-0 truncate font-mono text-badge text-ink-3 max-[860px]:hidden"
            title={revision()}
          >
            {revision()}
          </span>
        </Show>
        <span class="flex-1" />
        <Show when={duration()}>
          {(value) => <span class="font-mono text-badge text-ink-3">{value()}</span>}
        </Show>
      </div>

      <Show when={files().length > 0}>
        <ul class="mt-2 flex list-none flex-col gap-[3px] p-0">
          <For each={files()}>
            {(path) => (
              <li class="truncate font-mono text-badge text-ink-2" title={path}>
                {path}
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={patch() !== ''}>
        <details class="group mt-2">
          <summary class="flex w-fit cursor-pointer items-center gap-1.5 rounded-control py-0.5 text-badge text-ink-3 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            <Icon name="chevronRight" size={11} class="transition-transform group-open:rotate-90" />
            <span>{props.t('taskPatchFiles', { count: files().length })}</span>
          </summary>
          <DiffPatch
            class="mt-1.5"
            patch={patch()}
            limitLabel={props.t('patchLimit')}
            {...(props.execution.evidence?.diffTruncated === undefined
              ? {}
              : { truncated: props.execution.evidence.diffTruncated })}
          />
        </details>
      </Show>
    </section>
  )
}
