import { createSignal } from 'solid-js'

/**
 * 右栏（详情）的唯一状态源。
 *
 * 运行是对象，不是地点（ADR 0029 §2.2）：点开一次运行不该把对话换掉，
 * 而是让它在右栏展开。于是详情不再是一条路由，而是一个可关的观察面；
 * `/tasks/:id` 仍然深链，它打开的是同一块面板。
 *
 * 状态放模块级 signal：shell、侧栏和对话页都要读它，而它们不在同一棵子树里。
 * 这里只存“用户正在看什么”，不存数据——任务详情由 InspectorPanel 自己取。
 */
export type InspectorTarget =
  | { kind: 'closed' }
  | { kind: 'task'; taskId: string }
  | { kind: 'file'; taskId: string; path: string }

const WIDTH_KEY = 'hubagent.inspector.width'
const MIN_WIDTH = 320
const MAX_WIDTH = 760
const DEFAULT_WIDTH = 420

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

function storedWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

const [target, setTarget] = createSignal<InspectorTarget>({ kind: 'closed' })
const [width, setWidthSignal] = createSignal(storedWidth())

export const INSPECTOR_MIN = MIN_WIDTH
export const INSPECTOR_MAX = MAX_WIDTH

export const inspector = {
  target,
  width,
  /** 打开某次运行的详情；同一任务再次点击不重开。 */
  openTask: (taskId: string): void => {
    const current = target()
    if (current.kind === 'task' && current.taskId === taskId) return
    setTarget({ kind: 'task', taskId })
  },
  openFile: (taskId: string, path: string): void => {
    setTarget({ kind: 'file', taskId, path })
  },
  close: (): void => {
    setTarget({ kind: 'closed' })
  },
  /** 对话头部的开关：已开着就关，没开就展开本次运行的详情。 */
  toggleTask: (taskId: string): void => {
    const current = target()
    if (current.kind !== 'closed' && current.taskId === taskId) setTarget({ kind: 'closed' })
    else setTarget({ kind: 'task', taskId })
  },
  setWidth: (value: number): void => {
    const next = clamp(value)
    setWidthSignal(next)
    try {
      localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      // 隐私模式：记不住宽度而已。
    }
  },
}
