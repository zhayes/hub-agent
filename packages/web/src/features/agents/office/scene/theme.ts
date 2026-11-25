import * as THREE from 'three'
import type { SceneTheme } from '../contracts'

/**
 * 场景色板：CSS token → three 材质（PLAN-AGENT-OFFICE §4.2 / §4.3）。
 * 3D 颜色统一从这里读，不在渲染代码里散落 hex。明暗两套与 HUD 的 paper/ink 语言一致。
 */

export interface Palette {
  wall: number
  wallTop: number
  floor: number
  grid: number
  deskTop: number
  deskEdge: number
  deskLeg: number
  metal: number
  chair: number
  cushion: number
  paper: number
  ink: number
  accent: number
  ok: number
  warn: number
  bad: number
  lampWarm: number
  skin: number
  plant: number
  pot: number
  glass: number
  sky: number
  blue: number
}

export type ToneName = Exclude<keyof Palette, 'sky'>

export const PALETTES: Readonly<Record<SceneTheme, Palette>> = {
  light: {
    wall: 0xece1cc,
    wallTop: 0xe4d7bd,
    floor: 0xe4d9c0,
    grid: 0xcdbe9f,
    deskTop: 0xc08a58,
    deskEdge: 0x9a6b40,
    deskLeg: 0x6d5946,
    metal: 0x9c9385,
    chair: 0x8b6849,
    cushion: 0xb9895a,
    paper: 0xfdf7ea,
    ink: 0x2b241c,
    accent: 0xbd6428,
    ok: 0x527f59,
    warn: 0xb8811f,
    bad: 0xa1423a,
    lampWarm: 0xffcf8e,
    skin: 0xe9c7a6,
    plant: 0x62804f,
    pot: 0xa9714f,
    glass: 0xfff0c9,
    sky: 0xf7e3bd,
    blue: 0x3d6b85,
  },
  dark: {
    wall: 0x2a231b,
    wallTop: 0x241d16,
    floor: 0x1e1913,
    grid: 0x352c22,
    deskTop: 0x6b4f38,
    deskEdge: 0x533c2b,
    deskLeg: 0x3a2e24,
    metal: 0x6a625a,
    chair: 0x4a382b,
    cushion: 0x63452f,
    paper: 0xf6eddc,
    ink: 0x28211a,
    accent: 0xe18b3c,
    ok: 0x7fae86,
    warn: 0xd9a441,
    bad: 0xcf7264,
    lampWarm: 0xffc27a,
    skin: 0xdcb492,
    plant: 0x4a6640,
    pot: 0x7d5238,
    glass: 0xffe0a8,
    sky: 0x2b2a36,
    blue: 0x7aa8c2,
  },
}

/**
 * 材质缓存：按 tone 名缓存 MeshLambertMaterial。
 * 切明暗主题时只需重设颜色，不必重建场景（避免 context lost / 重建抖动）。
 */
export class MaterialCache {
  private palette: Palette
  private readonly cache = new Map<ToneName, THREE.MeshLambertMaterial>()

  constructor(theme: SceneTheme) {
    this.palette = PALETTES[theme]
  }

  get paletteNow(): Palette {
    return this.palette
  }

  mat(tone: ToneName): THREE.MeshLambertMaterial {
    let material = this.cache.get(tone)
    if (material === undefined) {
      material = new THREE.MeshLambertMaterial({ color: this.palette[tone] })
      this.cache.set(tone, material)
    }
    return material
  }

  /** 为主题切换重设所有已缓存材质颜色。 */
  recolor(theme: SceneTheme): void {
    this.palette = PALETTES[theme]
    for (const [tone, material] of this.cache) {
      material.color.setHex(this.palette[tone])
    }
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose()
    this.cache.clear()
  }
}

/** 阶段 → 状态灯/旗颜色（§2.2）。 */
export function phaseTone(palette: Palette, phase: string): number {
  switch (phase) {
    case 'working':
      return palette.ok
    case 'needs-approval':
    case 'needs-input':
    case 'degraded':
      return palette.warn
    case 'failed':
      return palette.bad
    case 'paused':
      return palette.metal
    default:
      return palette.grid
  }
}
