/**
 * Agent Office 舞台的类型契约（PLAN-AGENT-OFFICE §4）。
 *
 * 这一层**不 import 任何东西**：HUD/路由（stage-entry）与 three 场景（scene/**）
 * 都只依赖这里，避免 scene 反向依赖 shared/api、ui/** 或路由（§7.1）。
 */

/** 舞台上的稳定阶段；entering / done / leaving 是场景内部的瞬态，不在这里。 */
export type ScenePhase =
  | 'off-floor'
  | 'standby'
  | 'entering'
  | 'working'
  | 'needs-approval'
  | 'needs-input'
  | 'paused'
  | 'degraded'
  | 'failed'

export interface SceneAgent {
  id: string
  name: string
  phase: ScenePhase
  /** 工位序号（0..7）；没有工位时省略。 */
  deskIndex?: number
  /** 等候位序号（0..5）；没有等候位时省略。 */
  benchIndex?: number
  taskTitle?: string
  subtaskTitle?: string
  step?: number
  steps?: number
  attempt?: number
  /** 已完成执行的标题（用于完成瞬态的 DONE 票）；来自上一份快照。 */
  finishedTaskTitle?: string
}

export interface SceneSnapshot {
  agents: SceneAgent[]
}

/** 工位/等候位分配（由 presence.ts 的纯函数产出）。 */
export interface SeatAllocation {
  desks: Record<string, number>
  bench: Record<string, number>
  /** 需要工位/等候位但容量不足的 Agent。 */
  unseated: string[]
}

export type CameraPreset = 'overview' | 'desks' | 'entrance' | 'done'

export type SceneTheme = 'light' | 'dark'

export interface SceneMountOptions {
  theme: SceneTheme
  /** 页面隐藏时暂停渲染；prefers-reduced-motion 时跳过动画。 */
  reducedMotion: boolean
  /** 点击工位/人物时回调；空白处点击传 null。 */
  onSelect: (agentId: string | null) => void
}

export interface SceneController {
  /** 应用一份新的舞台快照（内部做 diff → 走位/姿态/完成瞬态）。 */
  setSnapshot: (snapshot: SceneSnapshot) => void
  /** 镜头聚焦某个 Agent 的工位；null 回到预设。 */
  focusAgent: (agentId: string | null) => void
  setPreset: (preset: CameraPreset) => void
  setTheme: (theme: SceneTheme) => void
  setReducedMotion: (value: boolean) => void
  /** 容器尺寸变化后调用。 */
  resize: () => void
  dispose: () => void
}
