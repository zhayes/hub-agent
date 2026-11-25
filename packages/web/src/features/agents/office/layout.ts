import type { CameraPreset } from './contracts'

/**
 * 布局数据化：桌位 / 等候位 / 相机预设都从这里读，不写死在渲染循环里
 * （PLAN-AGENT-OFFICE §2.1 / §4.2）。
 *
 * 坐标系：X 向右、Z 向屏幕下方、Y 向上；正交等距相机从右上前方俯视。
 * 8 个工位排成两排各 4 个；6 个等候位靠右墙。默认并发 3，房间有充足余量。
 */

export const DESK_CAPACITY = 8
export const BENCH_CAPACITY = 6

export const FLOOR_WIDTH = 19
export const FLOOR_DEPTH = 11.6

export interface Point2 {
  x: number
  z: number
}

/** 8 个工位（前排 4 + 后排 4）。 */
export const DESKS: readonly Point2[] = [
  { x: -5.4, z: -2.25 },
  { x: -1.8, z: -2.25 },
  { x: 1.8, z: -2.25 },
  { x: 5.4, z: -2.25 },
  { x: -4.5, z: 2.65 },
  { x: -0.9, z: 2.65 },
  { x: 2.7, z: 2.65 },
  { x: 6.2, z: 2.65 },
]

/** 6 个等候位，靠右墙一条长凳。 */
export const BENCH: readonly Point2[] = Array.from({ length: BENCH_CAPACITY }, (_, index) => ({
  x: 7.6,
  z: -2.75 + index * 1.1,
}))

export const DOOR: Point2 = { x: -FLOOR_WIDTH / 2 + 0.4, z: -2.2 }
export const DOOR_OUTSIDE: Point2 = { x: -FLOOR_WIDTH / 2 - 1.2, z: -2.2 }

/** 相机预设：正交尺寸 + 观察目标。 */
export interface CameraPresetConfig {
  size: number
  target: Point2
  /** 目标高度（Y），用于把注意力放在桌面高度而非地面。 */
  lift: number
}

export const CAMERA_PRESETS: Readonly<Record<CameraPreset, CameraPresetConfig>> = {
  overview: { size: 12.6, target: { x: 0.2, z: 0.5 }, lift: 1.35 },
  desks: { size: 9.4, target: { x: 0.4, z: -0.4 }, lift: 1.2 },
  entrance: { size: 7.6, target: { x: -6.2, z: 0.6 }, lift: 1.1 },
  done: { size: 7.4, target: { x: -6.2, z: -4.4 }, lift: 1.6 },
}

/** 正交相机固定等距机位（不做 WASD / 自由 orbit，§1.2）。 */
export const CAMERA_POSITION = { x: 15, y: 14.2, z: 17.5 } as const

export function deskPosition(index: number): Point2 {
  return DESKS[index] ?? DESKS[0] ?? { x: 0, z: 0 }
}

export function benchPosition(index: number): Point2 {
  return BENCH[index] ?? BENCH[0] ?? { x: 7.6, z: 0 }
}
