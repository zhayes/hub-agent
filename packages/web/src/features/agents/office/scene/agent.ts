import * as THREE from 'three'
import { contactShadow } from './textures'
import type { MaterialCache } from './theme'

export interface FigureConfig {
  shirt: number
  hair: number
  glasses: boolean
  cap: number
}

const SHIRTS = [0x51707f, 0x6d5b8e, 0x8a6a45, 0x4a7d63, 0x9a5a52, 0x50707f, 0x7d6a3f, 0x5f6f8f]
const HAIRS = [0x2f2620, 0x1f1a17, 0x4a3522, 0x241d18, 0x352a22, 0x3a2f26]

function hash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0
  }
  return result
}

/** 由 Agent id 稳定映射外观：同一 Agent 每次进来都是同一个人。 */
export function figureConfigFor(id: string): FigureConfig {
  const h = hash(id)
  return {
    shirt: SHIRTS[h % SHIRTS.length] ?? 0x51707f,
    hair: HAIRS[(h >> 3) % HAIRS.length] ?? 0x2f2620,
    glasses: (h & 0b100) !== 0,
    cap: 0.36 + ((h >> 5) % 8) * 0.01,
  }
}

/**
 * 纸片人：站/坐/走简单姿态 + 举手（等待）/靠背（暂停）。
 * 只表现 presence 事实，不做额外动作。
 */
export class Figure {
  readonly root: THREE.Group
  private readonly body: THREE.Group
  private readonly torso: THREE.Mesh
  private readonly head: THREE.Group
  private readonly legPivots: THREE.Group[] = []
  private readonly armPivots: THREE.Group[] = []
  private seated = false

  constructor(config: FigureConfig, materials: MaterialCache) {
    const palette = materials.paletteNow
    this.root = new THREE.Group()
    this.body = new THREE.Group()
    this.root.add(this.body)

    const skin = new THREE.MeshLambertMaterial({ color: palette.skin })
    const shirt = new THREE.MeshLambertMaterial({ color: config.shirt })
    const hair = new THREE.MeshLambertMaterial({ color: config.hair })
    const dark = new THREE.MeshLambertMaterial({ color: 0x211a15 })

    for (const sx of [-0.105, 0.105]) {
      const pivot = new THREE.Group()
      pivot.position.set(sx, 0.74, 0)
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.052, 0.72, 8), dark)
      leg.position.y = -0.36
      pivot.add(leg)
      this.body.add(pivot)
      this.legPivots.push(pivot)
    }

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.215, 0.34, 4, 12), shirt)
    this.torso.position.y = 0.98
    this.body.add(this.torso)

    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.22), shirt)
    shoulders.position.y = 1.2
    this.body.add(shoulders)

    this.head = new THREE.Group()
    this.head.position.y = 1.5
    this.body.add(this.head)
    this.head.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), skin))
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.212, 18, 14, 0, Math.PI * 2, 0, Math.PI * config.cap),
      hair,
    )
    hairCap.position.y = 0.008
    hairCap.rotation.x = 0.1
    this.head.add(hairCap)

    const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x241d18 })
    for (const ex of [-0.068, 0.068]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.021, 8, 8), eyeMaterial)
      eye.position.set(ex, 0.028, 0.183)
      this.head.add(eye)
    }

    for (const [sx, side] of [
      [-0.245, -1],
      [0.245, 1],
    ] as const) {
      const pivot = new THREE.Group()
      pivot.position.set(sx, 1.17, 0)
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.46, 8), shirt)
      arm.position.y = -0.23
      pivot.add(arm)
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.056, 8, 8), skin)
      hand.position.y = -0.47
      pivot.add(hand)
      pivot.rotation.z = side * 0.09
      this.body.add(pivot)
      this.armPivots.push(pivot)
    }

    this.root.add(contactShadow(0.62, 0.62, 0.2))
  }

  get isSeated(): boolean {
    return this.seated
  }

  setSeated(value: boolean): void {
    this.seated = value
    this.root.position.y = value ? -0.29 : 0
    for (const leg of this.legPivots) {
      leg.rotation.x = value ? -1.45 : 0
      leg.scale.y = value ? 0.62 : 1
      leg.position.y = value ? 0.66 : 0.74
    }
    if (value) this.torso.rotation.x = 0.06
  }

  /** 走路的腿部摆动（由场景推进相位驱动）；坐着不动。 */
  setWalkSwing(swing: number): void {
    if (this.seated) return
    const left = this.legPivots[0]
    const right = this.legPivots[1]
    if (left !== undefined) left.rotation.x = swing
    if (right !== undefined) right.rotation.x = -swing
    const armLeft = this.armPivots[0]
    const armRight = this.armPivots[1]
    if (armLeft !== undefined) armLeft.rotation.x = -swing * 0.7
    if (armRight !== undefined) armRight.rotation.x = swing * 0.7
  }

  raiseHand(on: boolean): void {
    const arm = this.armPivots[1]
    if (arm === undefined) return
    arm.rotation.x = on ? -2.45 : 0
    arm.rotation.z = on ? 0.22 : 0.09
  }

  leanBack(on: boolean): void {
    this.torso.rotation.x = on ? -0.2 : this.seated ? 0.06 : 0
    this.head.rotation.x = on ? -0.16 : 0
  }

  faceTo(x: number, z: number): void {
    this.root.rotation.y = Math.atan2(x - this.root.position.x, z - this.root.position.z)
  }

  dispose(): void {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        const material = object.material
        if (Array.isArray(material)) for (const item of material) item.dispose()
        else material.dispose()
      }
    })
  }
}
