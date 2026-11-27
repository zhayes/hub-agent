import { createSignal, For, Show } from 'solid-js'
import { Button, buttonClass } from '../../components/ui/Button'
import { Icon } from '../../components/ui/Icon'
import { toast } from '../../components/ui/Toaster'
import type { AgentRow, Decision, DeliveryResult, TaskView } from '../../shared/api'
import { api } from '../../shared/api'
import { type AttentionItem, approvalToAttention } from '../../shared/attention'
import { formatDuration, relativeTime, shortenId } from '../../shared/format'
import { type Locale, statusKey, type Translator } from '../../shared/i18n'
import { DecisionBody } from '../inbox/DecisionBody'
import { EvidenceNode, type NodeState } from './EvidenceNode'
import { TaskAttempt } from './TaskAttempt'
import {
  currentVerification,
  diffTotals,
  elapsedMs,
  evidenceExecution,
  executionAgents,
  failingCheck,
  failureReport,
  latestExecution,
  taskPhase,
} from './verdict'

/**
 * 任务详情（P5，§6.3）。
 *
 * 一屏结构：**一句判决 + 一条竖向证据脊柱**。
 * 判决在最上面，diffstat 与最近一条未通过的检查紧挨着它（§5.4）；
 * 脊柱按时间顺序回答「计划了什么 → 谁跑了什么 → 验收过了哪几项」；
 * 六段里最安静的两种（决策、事件）收进末端的「记录」，不跟三个阶段同权重。
 */

const DONE_STATUSES = new Set(['completed', 'succeeded'])
const FAILED_STATUSES = new Set(['failed', 'error'])

const checkIcon = 'grid size-4 place-items-center'
const fileRow = 'flex flex-wrap items-center gap-x-2 gap-y-1'
const metaLine = 'text-badge text-ink-3'

export interface TaskDetailViewProps {
  view: TaskView
  decisions: readonly Decision[]
  /** 全局 SSE 事件（最近 30 条）；这里按 goalId 过滤出属于本任务的。 */
  events: readonly string[]
  agents: readonly AgentRow[]
  /** 产生这次运行的对话；找不到时不给回链，也不编。 */
  sourceThread?: { id: string; title: string }
  locale: Locale
  t: Translator
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
}

interface TaskEvent {
  type: string
  at: string
}

function parseTaskEvent(raw: string, goalId: string): TaskEvent | undefined {
  try {
    const value = JSON.parse(raw) as { type?: unknown; at?: unknown; goalId?: unknown }
    if (typeof value.type !== 'string') return undefined
    if (value.goalId !== goalId) return undefined
    return { type: value.type, at: typeof value.at === 'string' ? value.at : '' }
  } catch {
    return undefined
  }
}

export function TaskDetailView(props: TaskDetailViewProps) {
  const [delivering, setDelivering] = createSignal(false)
  const [delivered, setDelivered] = createSignal<DeliveryResult>()

  const pending = (): AttentionItem[] =>
    props.view.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approvalToAttention(approval, props.view.task.title))

  const phase = () => taskPhase(props.view, pending().length)
  const checks = () => currentVerification(props.view)?.checks ?? []

  const failedChecks = () => checks().filter((check) => !check.passed)
  const diff = () => diffTotals(evidenceExecution(props.view)?.evidence?.diffstat)
  const elapsed = (): string | undefined => {
    const ms = elapsedMs(props.view)
    return ms === undefined ? undefined : formatDuration(ms)
  }
  const sha = (): string | undefined =>
    evidenceExecution(props.view)?.evidence?.commitSha?.slice(0, 8)
  const agentName = (id: string | undefined): string => {
    if (id === undefined || id === '') return ''
    return props.agents.find((agent) => agent.id === id)?.name ?? shortenId(id)
  }
  const uniqueNames = (ids: ReadonlyArray<string | undefined>): string[] => {
    const names = ids.map(agentName).filter((name) => name !== '')
    return [...new Set(names)]
  }
  /* 事件是「发生过什么」，所以按时间正序读：最新的在最下面。
     store 里是头插（最新在前），这里取最近 12 条后翻一次。 */
  const taskEvents = (): TaskEvent[] =>
    props.events
      .map((raw) => parseTaskEvent(raw, props.view.task.goalId))
      .filter((event): event is TaskEvent => event !== undefined)
      .slice(0, 12)
      .reverse()

  /* ---------- 四个阶段的节点状态 ---------- */

  const planState = (): NodeState => {
    const subtasks = props.view.subtasks
    if (subtasks.length === 0) return 'todo'
    if (subtasks.some((subtask) => FAILED_STATUSES.has(subtask.status))) return 'failed'
    if (subtasks.every((subtask) => DONE_STATUSES.has(subtask.status))) return 'done'
    return 'active'
  }

  const executeState = (): NodeState => {
    const latest = latestExecution(props.view)
    if (latest === undefined) return 'todo'
    if (latest.status === 'running') return phase() === 'waiting' ? 'waiting' : 'active'
    if (FAILED_STATUSES.has(latest.status)) return 'failed'
    return 'done'
  }

  const verifyState = (): NodeState => {
    if (checks().length === 0) return 'todo'
    return failedChecks().length > 0 ? 'failed' : 'done'
  }

  /* ---------- 判决条 ---------- */

  const verdictWord = (): string => {
    const value = phase()
    if (value === 'failed') return props.t('taskVerdictFail')
    if (value === 'waiting') return props.t('taskVerdictWaiting')
    if (value === 'cancelled') return props.t('statusCancelled')
    if (value === 'running') return props.t('taskVerdictRunning')
    return checks().length > 0 ? props.t('taskVerdictPass') : props.t('statusCompleted')
  }

  const verdictTone = (): string => {
    const value = phase()
    if (value === 'failed') return 'text-danger'
    if (value === 'waiting') return 'text-accent'
    if (value === 'done' && checks().length > 0) return 'text-success'
    return 'text-ink'
  }

  const verdictMeta = (): string => {
    const parts: string[] = []
    if (checks().length > 0) {
      parts.push(
        failedChecks().length > 0
          ? props.t('taskChecksFailed', {
              count: checks().length,
              failed: failedChecks().length,
            })
          : props.t('taskChecksPassed', { count: checks().length }),
      )
    }
    if (phase() === 'done' || phase() === 'failed') {
      const value = elapsed()
      if (value !== undefined) parts.push(props.t('taskElapsed', { duration: value }))
    }
    if (pending().length > 0) parts.push(props.t('pendingCount', { count: pending().length }))
    if (parts.length === 0) {
      const names = uniqueNames(executionAgents(props.view))
      if (names.length > 0) parts.push(names.join(' / '))
      parts.push(props.t('taskAttempts', { count: props.view.executions.length }))
    }
    return parts.join(' · ')
  }

  const headerMeta = (): string => {
    const parts = [
      props.t('taskAttempts', { count: props.view.executions.length }),
      props.t('taskSubtasks', { count: props.view.subtasks.length }),
    ]
    if (checks().length > 0) parts.push(props.t('taskChecks', { count: checks().length }))
    return parts.join(' · ')
  }

  /* 「验收」节点的元信息不再重复条数 / 结论（判决条已经说了），只说谁判的：
   判定来自 Runtime，不来自 Agent 自述（US-007）。 */
  const verifyMeta = (): string => {
    if (checks().length === 0) return props.t('taskVerifyPending')
    if (failedChecks().length > 0) {
      return props.t('taskChecksFailed', {
        count: checks().length,
        failed: failedChecks().length,
      })
    }
    return props.t('taskRuntimeChecks')
  }

  const executeMeta = (): string => {
    const executions = props.view.executions
    if (executions.length === 0) return props.t('noEvidence')
    const parts = [props.t('taskTimes', { count: executions.length })]
    const names = uniqueNames(executionAgents(props.view))
    if (names.length > 0) parts.push(names.join(' / '))
    return parts.join(' · ')
  }

  const planMeta = (): string => {
    const parts = [props.t('taskSubtasks', { count: props.view.subtasks.length })]
    const names = uniqueNames(props.view.subtasks.map((subtask) => subtask.assignedAgentId))
    if (names.length > 0) parts.push(names.join(' / '))
    return parts.join(' · ')
  }

  const recordsMeta = (): string => {
    const parts = [props.t('taskDecisionCount', { count: props.decisions.length })]
    if (taskEvents().length > 0) {
      parts.push(props.t('taskEventCount', { count: taskEvents().length }))
    }
    return parts.join(' · ')
  }

  const copyFailure = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(failureReport(props.view))
      toast(props.t('taskCopied'))
    } catch {
      toast(props.t('taskCopyFailed'))
    }
  }

  /* 交付（PRD §6.12.4）：验收通过之后才谈「这份产出怎么拿走」。
     只给 patch-export —— branch-only 本来就是默认结果（分支保留在原处），
     auto-merge 需要项目配置，接口会拒绝并说明原因。 */
  const exportPatch = async (): Promise<void> => {
    setDelivering(true)
    try {
      const result = await api.deliverTask(props.view.task.id, 'patch-export')
      setDelivered(result.delivery)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDelivering(false)
    }
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <header class="flex-none px-5 pt-[18px] pb-3.5 max-[860px]:px-4 max-[860px]:pt-3.5 max-[860px]:pb-2.5">
        <div class="mx-auto w-full max-w-[720px]">
          <Show when={props.sourceThread}>
            {(thread) => (
              <a
                class="inline-flex max-w-full items-center gap-1 rounded-control py-0.5 pr-1 pl-0.5 text-badge text-ink-3 transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                href={`/chat/${thread().id}`}
              >
                <span class="truncate">{props.t('taskSource', { title: thread().title })}</span>
                <Icon name="chevronRight" size={11} class="shrink-0" />
              </a>
            )}
          </Show>

          <h1 class="mt-1 text-[17px] font-semibold leading-[1.35] tracking-[-0.006em] text-ink max-[860px]:text-[16px]">
            {props.view.task.title}
          </h1>

          <Show
            when={
              props.view.task.description !== '' &&
              props.view.task.description !== props.view.task.title
            }
          >
            <p class="mt-1.5 max-w-[62ch] text-meta text-ink-2">{props.view.task.description}</p>
          </Show>

          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-badge text-ink-3">
            <span>{headerMeta()}</span>
            <Show when={sha()}>
              {(value) => (
                <>
                  <span class="text-line-strong">·</span>
                  <span class="font-mono">{value()}</span>
                </>
              )}
            </Show>
          </div>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-10 max-[860px]:px-4">
        <div class="mx-auto w-full max-w-[720px]">
          {/* 判决：结论 + 紧挨着结论的证据（§5.4） */}
          <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span
              class={`inline-flex items-center gap-1.5 text-body font-semibold ${verdictTone()}`}
            >
              <Show when={phase() === 'failed'}>
                <Icon name="x" size={14} />
              </Show>
              <Show when={phase() === 'waiting'}>
                <span class="size-1.5 rounded-full bg-accent" aria-hidden="true" />
              </Show>
              <Show when={phase() === 'done' && checks().length > 0}>
                <Icon name="check" size={14} />
              </Show>
              {verdictWord()}
            </span>
            <Show when={diff().added + diff().removed > 0}>
              <span class="font-mono text-badge">
                <span class="text-success">+{diff().added}</span>{' '}
                <span class="text-danger">−{diff().removed}</span>
              </span>
            </Show>
            <span class="flex-1" />
            <span class={metaLine}>{verdictMeta()}</span>
          </div>

          {/* 未通过时把“哪一条挂了”放在结论下面：不用展开，也不用点 */}
          <Show when={phase() === 'failed' && failingCheck(props.view)}>
            {(check) => (
              <div class="mt-2.5 flex flex-wrap items-center gap-2 text-meta text-ink-2">
                <span class="text-badge text-ink-3">{props.t('taskLatestFailure')}</span>
                <code class="rounded-[5px] border border-line bg-subtle px-1.5 font-mono text-badge text-ink">
                  {check().command ?? check().kind}
                </code>
                <Show when={check().exitCode !== undefined}>
                  <span class="font-mono text-badge text-danger">
                    {props.t('commandExit', { code: check().exitCode ?? 0 })}
                  </span>
                </Show>
                <Show when={check().outputRef}>
                  {(ref) => (
                    <>
                      <span class="text-line-strong">·</span>
                      <span class={metaLine}>{props.t('taskOutput')}</span>
                      <code class="truncate font-mono text-badge text-ink-3" title={ref()}>
                        {ref()}
                      </code>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>

          {/* 判决通过后给「把改动拿走」这一步：交付是用户显式动作（PRD §6.12.4）。 */}
          <Show
            when={
              phase() === 'done' &&
              checks().length > 0 &&
              failedChecks().length === 0 &&
              (evidenceExecution(props.view)?.evidence?.diff ?? '') !== ''
            }
          >
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={delivering()}
                onClick={() => void exportPatch()}
              >
                <Icon name="copy" size={13} />
                {delivering() ? props.t('taskExporting') : props.t('taskExportPatch')}
              </Button>
              <Show when={delivered()}>
                {(value) => (
                  <span class={`${metaLine} truncate font-mono`} title={value().patchRef ?? ''}>
                    {props.t('taskPatchExported', { path: value().patchRef ?? '' })}
                  </span>
                )}
              </Show>
            </div>
          </Show>

          <ol class="mt-[18px] list-none p-0">
            <EvidenceNode
              state={planState()}
              title={props.t('stepPlan')}
              meta={planMeta()}
              open={false}
            >
              <Show
                when={props.view.subtasks.length > 0}
                fallback={<p class="text-meta text-ink-2">{props.t('noSubtasks')}</p>}
              >
                <ul class="flex list-none flex-col gap-[7px] p-0">
                  <For each={props.view.subtasks}>
                    {(subtask) => (
                      <li class="grid grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-2.5 text-meta">
                        <span
                          class={`${checkIcon} ${
                            FAILED_STATUSES.has(subtask.status)
                              ? 'text-danger'
                              : DONE_STATUSES.has(subtask.status)
                                ? 'text-success'
                                : 'text-ink-3'
                          }`}
                        >
                          <Icon
                            name={
                              FAILED_STATUSES.has(subtask.status)
                                ? 'x'
                                : DONE_STATUSES.has(subtask.status)
                                  ? 'check'
                                  : 'chevronRight'
                            }
                            size={13}
                          />
                        </span>
                        <span class="truncate text-ink-2" title={subtask.title}>
                          {subtask.title}
                        </span>
                        <span class="truncate font-mono text-badge text-ink-3 max-[860px]:hidden">
                          {agentName(subtask.assignedAgentId)}
                        </span>
                        <span class="text-badge whitespace-nowrap text-ink-3">
                          {props.t(statusKey(subtask.status))}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </EvidenceNode>

            {/* 「需要你」不是时间线上的一步，是卡在这里的那件事：常驻展开，并带上琥珀色 */}
            <For each={pending()}>
              {(item) => (
                <EvidenceNode state="waiting" title={props.t('taskNeedsYou')} collapsible={false}>
                  <div class="pb-4">
                    <DecisionBody
                      item={item}
                      t={props.t}
                      onApprove={props.onApprove}
                      onReject={props.onReject}
                    />
                  </div>
                </EvidenceNode>
              )}
            </For>

            <EvidenceNode
              state={executeState()}
              title={props.t('stepExecute')}
              meta={executeMeta()}
            >
              <Show
                when={props.view.executions.length > 0}
                fallback={<p class="text-meta text-ink-2">{props.t('noEvidence')}</p>}
              >
                <For each={props.view.executions}>
                  {(execution, index) => (
                    <TaskAttempt
                      execution={execution}
                      agentName={agentName(execution.agentId)}
                      t={props.t}
                      first={index() === 0}
                    />
                  )}
                </For>
              </Show>
            </EvidenceNode>

            <EvidenceNode
              state={verifyState()}
              title={props.t('stepVerify')}
              meta={verifyMeta()}
              collapsible={checks().length > 0}
            >
              <Show when={checks().length > 0}>
                <ul class="flex list-none flex-col gap-[7px] p-0">
                  <For each={checks()}>
                    {(check) => (
                      <li class="grid grid-cols-[16px_84px_minmax(0,1fr)_auto] items-center gap-2.5 text-meta max-[860px]:grid-cols-[16px_minmax(0,1fr)_auto]">
                        <span
                          class={`${checkIcon} ${check.passed ? 'text-success' : 'text-danger'}`}
                        >
                          <Icon name={check.passed ? 'check' : 'x'} size={13} />
                        </span>
                        <span class="truncate text-ink-2 max-[860px]:hidden">{check.kind}</span>
                        <span
                          class="truncate font-mono text-badge text-ink-3"
                          title={check.command ?? check.outputRef ?? ''}
                        >
                          {check.command ?? check.outputRef ?? '—'}
                        </span>
                        <span
                          class={`font-mono text-badge whitespace-nowrap ${
                            check.passed ? 'text-ink-3' : 'text-danger'
                          }`}
                        >
                          <Show
                            when={check.exitCode !== undefined}
                            fallback={check.passed ? '' : '—'}
                          >
                            {props.t('commandExit', { code: check.exitCode ?? 0 })}
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>

                {/* 失败节点就地给动作：不新开页面，也不藏到菜单里 */}
                <Show when={phase() === 'failed'}>
                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    <Show
                      when={props.sourceThread}
                      fallback={<span class={metaLine}>{props.t('taskNoConversation')}</span>}
                    >
                      {(thread) => (
                        <a class={buttonClass({ size: 'sm' })} href={`/chat/${thread().id}`}>
                          {props.t('taskContinueInChat')}
                        </a>
                      )}
                    </Show>
                    <Button size="sm" variant="secondary" onClick={() => void copyFailure()}>
                      {props.t('taskCopyFailure')}
                    </Button>
                  </div>
                </Show>
              </Show>
            </EvidenceNode>

            <EvidenceNode
              state="done"
              quiet
              title={props.t('taskRecords')}
              meta={recordsMeta()}
              open={false}
              last
            >
              <Show
                when={props.decisions.length > 0}
                fallback={<p class="text-meta text-ink-2">{props.t('noDecisions')}</p>}
              >
                <ul class="flex list-none flex-col gap-2.5 p-0">
                  <For each={props.decisions}>
                    {(decision) => (
                      <li class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                        <span class="truncate font-mono text-badge text-ink-2">
                          {decision.type}
                        </span>
                        <time class="font-mono text-badge text-ink-3" datetime={decision.decidedAt}>
                          {relativeTime(props.locale, decision.decidedAt)}
                        </time>
                        <p class="col-span-full mt-0.5 max-w-[62ch] text-meta text-ink-3">
                          {decision.rationale}
                        </p>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <Show when={taskEvents().length > 0}>
                <div class="mt-3 border-t border-line pt-2.5">
                  <p class="mb-1 text-badge text-ink-3">{props.t('taskRecentEvents')}</p>
                  <ul class="flex list-none flex-col gap-[3px] p-0">
                    <For each={taskEvents()}>
                      {(event) => (
                        <li class={fileRow}>
                          <span class="font-mono text-badge text-ink-2">{event.type}</span>
                          <span class="flex-1 border-b border-dotted border-line-strong" />
                          <span class="font-mono text-badge text-ink-3">
                            {event.at === '' ? '' : relativeTime(props.locale, event.at)}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </EvidenceNode>
          </ol>
        </div>
      </div>
    </div>
  )
}
