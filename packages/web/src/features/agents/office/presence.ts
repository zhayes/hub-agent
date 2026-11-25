import type { AgentPresence } from '../../../shared/api'
import type { SceneAgent, ScenePhase, SeatAllocation } from './contracts'
import { BENCH_CAPACITY, DESK_CAPACITY } from './layout'

/**
 * presence → 舞台阶段 + 座位分配（纯函数，PLAN-AGENT-OFFICE §3.2 / §2.3）。
 *
 * 全部只读、可单测；不在这里发请求、不读 DOM、不 import three。
 */

export const EMPTY_ALLOCATION: SeatAllocation = { desks: {}, bench: {}, unseated: [] }

/**
 * §2.2 状态映射（服务端事实 → 舞台阶段）。
 * 注意 paused 不算活跃执行：presence 是 online，但 activity.executionStatus 是 paused。
 */
export function phaseOf(agent: AgentPresence): ScenePhase {
  switch (agent.presence) {
    case 'discovered':
    case 'offline':
    case 'disabled':
      return 'off-floor'
    case 'error':
      return 'failed'
    case 'degraded':
      return 'degraded'
    case 'starting':
    case 'initializing':
      return 'entering'
    case 'busy':
      if (agent.activity?.waitingOn === 'permission') return 'needs-approval'
      if (agent.activity?.waitingOn === 'input') return 'needs-input'
      return 'working'
    case 'online':
      return agent.activity?.executionStatus === 'paused' ? 'paused' : 'standby'
    default:
      // 未知状态不猜：当作不在场（HUD 仍会显示「未知」）。
      return 'off-floor'
  }
}

const DESK_PHASES: ReadonlySet<ScenePhase> = new Set<ScenePhase>([
  'entering',
  'working',
  'needs-approval',
  'needs-input',
  'paused',
  'degraded',
  'failed',
])

export function occupiesDesk(phase: ScenePhase): boolean {
  return DESK_PHASES.has(phase)
}

export function needsAttention(phase: ScenePhase): boolean {
  return phase === 'needs-approval' || phase === 'needs-input' || phase === 'failed'
}

/** 注意力严重度：越小越靠前（等待授权 > 等待补充 > 故障）。 */
export function attentionRank(agent: AgentPresence): number {
  const phase = phaseOf(agent)
  if (phase === 'needs-approval') return 0
  if (phase === 'needs-input') return 1
  if (phase === 'failed') return 2
  return 99
}

/** 需要你的 Agent，按严重度 + 已等待时长排序（供 `N` 跳转与 banner）。 */
export function attentionAgents(agents: readonly AgentPresence[]): AgentPresence[] {
  return agents
    .filter((agent) => needsAttention(phaseOf(agent)))
    .slice()
    .sort((a, b) => {
      const rank = attentionRank(a) - attentionRank(b)
      if (rank !== 0) return rank
      return waitedSince(a).localeCompare(waitedSince(b))
    })
}

function waitedSince(agent: AgentPresence): string {
  return agent.pendingApprovals[0]?.requestedAt ?? agent.activity?.startedAt ?? ''
}

function firstFree(used: ReadonlySet<number>, capacity: number): number | undefined {
  for (let index = 0; index < capacity; index += 1) {
    if (!used.has(index)) return index
  }
  return undefined
}

/**
 * 稳定分配：一个 Agent 一个工位。
 * - 保留上一轮的分配（重复派发只换任务牌，不重弹桌、不重走位）；
 * - 新进入者分配到第一个空位；容量不足记入 unseated（HUD 显示 floor full）。
 */
export function allocateSeats(
  agents: readonly AgentPresence[],
  previous: SeatAllocation = EMPTY_ALLOCATION,
): SeatAllocation {
  const desks: Record<string, number> = {}
  const bench: Record<string, number> = {}
  const usedDesks = new Set<number>()
  const usedBench = new Set<number>()
  const unseated: string[] = []

  const wantDesk: AgentPresence[] = []
  const wantBench: AgentPresence[] = []
  for (const agent of agents) {
    const phase = phaseOf(agent)
    if (occupiesDesk(phase)) wantDesk.push(agent)
    else if (phase === 'standby') wantBench.push(agent)
  }

  for (const agent of wantDesk) {
    const index = previous.desks[agent.id]
    if (index !== undefined && index < DESK_CAPACITY && !usedDesks.has(index)) {
      desks[agent.id] = index
      usedDesks.add(index)
    }
  }
  for (const agent of wantBench) {
    const index = previous.bench[agent.id]
    if (index !== undefined && index < BENCH_CAPACITY && !usedBench.has(index)) {
      bench[agent.id] = index
      usedBench.add(index)
    }
  }

  for (const agent of wantDesk) {
    if (desks[agent.id] !== undefined) continue
    const index = firstFree(usedDesks, DESK_CAPACITY)
    if (index === undefined) {
      unseated.push(agent.id)
      continue
    }
    desks[agent.id] = index
    usedDesks.add(index)
  }
  for (const agent of wantBench) {
    if (bench[agent.id] !== undefined) continue
    const index = firstFree(usedBench, BENCH_CAPACITY)
    if (index === undefined) {
      unseated.push(agent.id)
      continue
    }
    bench[agent.id] = index
    usedBench.add(index)
  }

  return { desks, bench, unseated }
}

/** 把 API 的 presence 列表转成场景快照。 */
export function toSceneAgents(
  agents: readonly AgentPresence[],
  allocation: SeatAllocation,
  finishedTaskTitle: Readonly<Record<string, string>> = {},
): SceneAgent[] {
  return agents.map((agent) => {
    const phase = phaseOf(agent)
    const deskIndex = allocation.desks[agent.id]
    const benchIndex = allocation.bench[agent.id]
    const finished = finishedTaskTitle[agent.id]
    return {
      id: agent.id,
      name: agent.name,
      phase,
      ...(deskIndex === undefined ? {} : { deskIndex }),
      ...(benchIndex === undefined ? {} : { benchIndex }),
      ...(agent.activity === undefined ? {} : { taskTitle: agent.activity.taskTitle }),
      ...(agent.activity === undefined ? {} : { subtaskTitle: agent.activity.subtaskTitle }),
      ...(agent.activity?.step === undefined ? {} : { step: agent.activity.step }),
      ...(agent.activity?.steps === undefined ? {} : { steps: agent.activity.steps }),
      ...(agent.activity === undefined ? {} : { attempt: agent.activity.attempt }),
      ...(finished === undefined ? {} : { finishedTaskTitle: finished }),
    }
  })
}
