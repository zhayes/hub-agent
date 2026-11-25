import type { SceneAgent, ScenePhase } from '../contracts'

/**
 * 动作编排（纯函数，可单测；PLAN-AGENT-OFFICE §4.2 / G3）。
 *
 * 这里只回答「该做什么」，不碰 three、不碰 DOM。场景把结果翻译成走位/姿态，
 * 因此动画只能由 presence diff / 事件触发，**没有随机走动、没有假进度**。
 */

export interface Pose {
  seated: boolean
  /** 举手（等待授权/补充）。 */
  hand: boolean
  /** 靠背（暂停）。 */
  lean: boolean
}

export type MoveTarget = 'hide' | 'bench' | 'desk'

export type PhaseAction =
  | 'enter'
  | 'walk-desk'
  | 'walk-bench'
  | 'sit'
  | 'stand'
  | 'raise-hand'
  | 'lower-hand'
  | 'lean-back'
  | 'sit-up'
  | 'stamp'
  | 'fold-desk'
  | 'leave'

const DESK_PHASES: ReadonlySet<ScenePhase> = new Set<ScenePhase>([
  'entering',
  'working',
  'needs-approval',
  'needs-input',
  'paused',
  'degraded',
  'failed',
])

export function poseOf(phase: ScenePhase): Pose {
  const atDesk = DESK_PHASES.has(phase)
  return {
    seated: atDesk || phase === 'standby',
    hand: phase === 'needs-approval' || phase === 'needs-input',
    lean: phase === 'paused',
  }
}

/** 目标位置：hidden（离场）→ bench（待命）→ desk（在工位）。 */
export function moveTarget(agent: SceneAgent): MoveTarget {
  if (agent.phase === 'off-floor') return 'hide'
  if (agent.phase === 'standby') return 'bench'
  return 'desk'
}

/** 从「在工位干活」变成「待命/离场」，触发盖章 + 票据归档的完成瞬态。 */
export function isFinishing(prev: ScenePhase | undefined, next: ScenePhase): boolean {
  if (prev === undefined) return false
  return DESK_PHASES.has(prev) && (next === 'standby' || next === 'off-floor')
}

/** 该阶段是否应当在场（用于判断首次进场）。 */
export function isOnFloor(phase: ScenePhase): boolean {
  return phase !== 'off-floor'
}

/**
 * 阶段迁移 → 动作序列（供单测与结构断言）。场景内部按位姿/目标执行，
 * 但语义必须与此一致：没有数据库事实就没有动作。
 */
export function phaseActions(prev: ScenePhase | undefined, next: ScenePhase): PhaseAction[] {
  if (prev === next) return []
  const actions: PhaseAction[] = []

  if (next === 'off-floor') {
    if (prev !== undefined && isOnFloor(prev)) actions.push('stand', 'leave')
    return actions
  }

  if (prev === undefined || prev === 'off-floor') {
    actions.push('enter')
    if (next === 'standby') actions.push('walk-bench')
    else actions.push('walk-desk', 'sit')
  } else if (next === 'standby') {
    actions.push('stand', 'walk-bench')
  } else if (prev === 'standby' || prev === 'entering') {
    if (prev === 'standby') actions.push('stand')
    actions.push('walk-desk', 'sit')
  }

  const pose = poseOf(next)
  if (pose.hand) actions.push('raise-hand')
  else actions.push('lower-hand')
  if (pose.lean) actions.push('lean-back')
  else actions.push('sit-up')

  if (isFinishing(prev, next)) actions.push('stamp', 'fold-desk')

  return actions
}
