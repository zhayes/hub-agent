import { For, Show } from 'solid-js'
import { Icon } from '../../components/ui/Icon'
import type { AttentionItem } from '../../shared/attention'
import type { Translator } from '../../shared/i18n'
import { DecisionBody } from '../inbox/DecisionBody'

export type RunPhase = 'running' | 'waiting' | 'done' | 'failed'

export interface DockAgent {
  name: string
  /** 正在做什么：子任务标题。 */
  label: string
  status: 'running' | 'done' | 'failed'
}

export interface RunDockProps {
  phase: RunPhase
  agents: DockAgent[]
  /** 本会话（同一 task）里待你仲裁的事。 */
  approvals: AttentionItem[]
  elapsedMs: number
  open: boolean
  onToggle: () => void
  onApprove: (approvalId: string) => void
  onReject: (approvalId: string) => void
  t: Translator
}

/** 18px 首字母徽标：拿到官方 logo 前的位置替身（v8 决定 R）。 */
export function agentBadge(name: string): string {
  const words = name
    .split(/[\s_-]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '')
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('')
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const row = 'flex items-center gap-2.5 text-meta'
const badge =
  'grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-ink text-[9px] font-semibold tracking-tight text-canvas'

/**
 * 输入框上方的 dock（v9 §3.7.3）：回答“**现在怎么了**”。
 *
 * 对话是记录（发生过什么），这里是现在（谁在跑、卡在哪）。
 * 它本身是一张卡片——否则状态条会和对话、输入框糊成一片；
 * 卡片只有一层：内部不套框、不画竖线。
 * 右侧元信息按状态给不同内容，**不能让子组件各自去写**（轮播曾把「已完成」写成「3 个待审批」）。
 */
export function RunDock(props: RunDockProps) {
  const label = (): string =>
    props.phase === 'running'
      ? props.t('chatTurnRunning')
      : props.phase === 'waiting'
        ? props.t('chatTurnWaiting')
        : props.phase === 'failed'
          ? props.t('chatTurnFailed')
          : props.t('dockFinished')

  const tone = (): string =>
    props.phase === 'waiting'
      ? 'text-warning'
      : props.phase === 'failed'
        ? 'text-danger'
        : props.phase === 'done'
          ? 'text-success'
          : 'text-ink-2'

  const meta = (): string => {
    if (props.approvals.length > 0) {
      return props.approvals.length === 1
        ? props.t('dockApprovalOne')
        : props.t('dockApprovals', { count: props.approvals.length })
    }
    const count = props.agents.length
    if (props.phase === 'running') {
      return `${props.t('dockAgents', { count })} · ${formatElapsed(props.elapsedMs)}`
    }
    return props.t('dockAgents', { count })
  }

  return (
    <section class="mx-auto mb-2 w-full max-w-[720px] px-0" aria-label={props.t('dockTitle')}>
      <div class="rounded-panel border border-line bg-surface px-3 pt-2 pb-2.5">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-control px-1 py-0.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-expanded={props.open ? 'true' : 'false'}
          onClick={() => props.onToggle()}
        >
          <span class="grid size-[18px] shrink-0 place-items-center text-ink-3" aria-hidden="true">
            <Icon
              name="chevronRight"
              size={11}
              class={`transition-transform duration-150 ${props.open ? 'rotate-90' : ''}`}
            />
          </span>
          <span class={`shrink-0 text-meta font-medium ${tone()}`}>{label()}</span>
          <span class="flex-1" />
          <span class="shrink-0 text-badge tabular-nums text-ink-3">{meta()}</span>
        </button>

        <Show when={props.open}>
          <div class="px-1 pb-1">
            <Show
              when={props.approvals[0]}
              fallback={
                <Show
                  when={props.agents.length > 0}
                  fallback={<p class="text-badge text-ink-3">{props.t('attentionClear')}</p>}
                >
                  <ul class="flex list-none flex-col gap-1.5 p-0">
                    <For each={props.agents}>
                      {(agent) => (
                        <li class={row}>
                          <span
                            class={`${badge} ${
                              agent.status === 'running'
                                ? 'ring-2 ring-accent/40'
                                : agent.status === 'failed'
                                  ? 'bg-danger text-canvas'
                                  : ''
                            }`}
                            aria-hidden="true"
                          >
                            {agentBadge(agent.name)}
                          </span>
                          <span class="shrink-0 text-ink">{agent.name}</span>
                          <span class="min-w-0 flex-1 truncate text-ink-2">
                            {agent.label === '' ? '' : `· ${agent.label}`}
                          </span>
                          <span
                            class={`shrink-0 text-badge ${
                              agent.status === 'failed'
                                ? 'text-danger'
                                : agent.status === 'done'
                                  ? 'text-success'
                                  : 'text-ink-3'
                            }`}
                          >
                            {agent.status === 'failed'
                              ? props.t('stepFailed')
                              : agent.status === 'done'
                                ? props.t('stepDone')
                                : props.t('stepRunning')}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              }
            >
              {(item) => (
                <DecisionBody
                  item={item()}
                  t={props.t}
                  onApprove={props.onApprove}
                  onReject={props.onReject}
                />
              )}
            </Show>
          </div>
        </Show>
      </div>
    </section>
  )
}
