import * as THREE from 'three'
import type { ScenePhase } from '../contracts'
import { deskPosition } from '../layout'
import { contactShadow, paperMaterial, textTexture } from './textures'
import { type MaterialCache, phaseTone } from './theme'

export interface DeskOccupant {
  name: string
  taskTitle?: string
  subtaskTitle?: string
  step?: number
  steps?: number
  attempt?: number
}

const PHASE_CAPTION: Readonly<Record<ScenePhase, string>> = {
  'off-floor': 'OFF THE FLOOR',
  standby: 'STANDBY',
  entering: 'ENTERING',
  working: 'WORKING',
  'needs-approval': 'NEEDS APPROVAL',
  'needs-input': 'WAITING ON YOU',
  paused: 'PAUSED',
  degraded: 'DEGRADED',
  failed: 'FAILED',
}

export class Desk {
  readonly root: THREE.Group
  readonly furniture: THREE.Group
  readonly seatPosition: THREE.Vector3
  readonly hitbox: THREE.Mesh
  readonly index: number

  private readonly materials: MaterialCache
  private readonly blueprint: THREE.Line
  private readonly blueprintMaterial: THREE.LineBasicMaterial
  private readonly ticks: THREE.LineSegments
  private readonly ticksMaterial: THREE.LineBasicMaterial
  private readonly tag: THREE.Mesh
  private readonly plate: THREE.Mesh
  private readonly paper: THREE.Mesh
  private readonly clothMaterial: THREE.MeshLambertMaterial
  private readonly shadeMaterial: THREE.MeshLambertMaterial
  private readonly bulb: THREE.PointLight

  private occupant: DeskOccupant | undefined
  private phase: ScenePhase = 'off-floor'

  constructor(index: number, materials: MaterialCache) {
    this.index = index
    this.materials = materials
    const spot = deskPosition(index)
    this.root = new THREE.Group()
    this.root.position.set(spot.x, 0, spot.z)

    this.furniture = new THREE.Group()
    this.root.add(this.furniture)

    /* 桌面 + 桌腿 + 键盘 */
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.08, 0.9), materials.mat('deskTop'))
    top.position.y = 0.83
    this.furniture.add(top)
    const lip = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.1, 0.06), materials.mat('deskEdge'))
    lip.position.set(0, 0.8, -0.44)
    this.furniture.add(lip)
    for (const [lx, lz] of [
      [-0.74, -0.34],
      [0.74, -0.34],
      [-0.74, 0.34],
      [0.74, 0.34],
    ] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.07), materials.mat('deskLeg'))
      leg.position.set(lx, 0.4, lz)
      this.furniture.add(leg)
    }
    const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.03, 0.17), materials.mat('metal'))
    keyboard.position.set(0, 0.88, 0.16)
    this.furniture.add(keyboard)

    /* 姓名牌 */
    this.plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.22),
      paperMaterial(this.openPlateTexture()),
    )
    this.plate.position.set(0, 0.9, 0.47)
    this.plate.rotation.x = -0.18
    this.furniture.add(this.plate)

    /* 任务纸 */
    this.paper = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.28),
      paperMaterial(this.openPaperTexture()),
    )
    this.paper.rotation.x = -Math.PI / 2
    this.paper.position.set(-0.36, 0.876, 0.14)
    this.paper.rotation.z = 0.1
    this.furniture.add(this.paper)

    /* 椅子 */
    const chair = new THREE.Group()
    chair.position.set(0, 0, -0.95)
    this.furniture.add(chair)
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.07, 0.5), materials.mat('cushion'))
    seat.position.y = 0.45
    chair.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.5, 0.07), materials.mat('chair'))
    back.position.set(0, 0.71, -0.22)
    back.rotation.x = -0.08
    chair.add(back)

    /* 台灯（阶段灯） */
    const lamp = new THREE.Group()
    lamp.position.set(0.66, 0.87, -0.3)
    this.furniture.add(lamp)
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6),
      materials.mat('metal'),
    )
    stem.position.y = 0.25
    stem.rotation.z = -0.16
    lamp.add(stem)
    this.shadeMaterial = new THREE.MeshLambertMaterial({
      color: materials.paletteNow.accent,
      emissive: new THREE.Color(materials.paletteNow.lampWarm),
      emissiveIntensity: 0.28,
    })
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.16, 10, 1, true),
      this.shadeMaterial,
    )
    shade.position.set(-0.08, 0.5, 0.02)
    shade.rotation.x = Math.PI
    lamp.add(shade)
    this.bulb = new THREE.PointLight(materials.paletteNow.lampWarm, 2.4, 3.6, 2)
    this.bulb.position.set(-0.08, 0.4, 0.05)
    lamp.add(this.bulb)

    /* 纸旗（等待/故障时醒目） */
    const flag = new THREE.Group()
    flag.position.set(-0.8, 0.87, -0.36)
    this.furniture.add(flag)
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.72, 6),
      materials.mat('metal'),
    )
    pole.position.y = 0.36
    flag.add(pole)
    this.clothMaterial = new THREE.MeshLambertMaterial({
      color: materials.paletteNow.grid,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    })
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.17, 4, 2), this.clothMaterial)
    cloth.position.set(0.14, 0.63, 0)
    flag.add(cloth)

    this.root.add(contactShadow(2.1, 1.3, 0.26))

    /* 蓝图（空位提示） */
    const blueprintPoints = [
      new THREE.Vector3(-0.86, 0.03, -0.45),
      new THREE.Vector3(0.86, 0.03, -0.45),
      new THREE.Vector3(0.86, 0.03, 0.45),
      new THREE.Vector3(-0.86, 0.03, 0.45),
      new THREE.Vector3(-0.86, 0.03, -0.45),
    ]
    this.blueprintMaterial = new THREE.LineBasicMaterial({
      color: materials.paletteNow.accent,
      transparent: true,
      opacity: 0.34,
    })
    this.blueprint = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(blueprintPoints),
      this.blueprintMaterial,
    )
    this.root.add(this.blueprint)
    this.ticksMaterial = new THREE.LineBasicMaterial({
      color: materials.paletteNow.accent,
      transparent: true,
      opacity: 0.55,
    })
    this.ticks = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.86, 0.03, -0.45),
        new THREE.Vector3(-0.58, 0.03, -0.45),
        new THREE.Vector3(-0.86, 0.03, -0.45),
        new THREE.Vector3(-0.86, 0.03, -0.17),
      ]),
      this.ticksMaterial,
    )
    this.root.add(this.ticks)

    /* 地面占位牌 */
    this.tag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.17),
      paperMaterial(
        textTexture(
          [
            { text: 'OPEN DESK', size: 26, weight: 700, align: 'center' },
            { text: 'hubagent agent add', size: 13, weight: 400, mono: true, align: 'center' },
          ],
          { w: 384, h: 128, bg: '#f2e7d1', rule: false, pad: 10 },
        ),
      ),
    )
    this.tag.rotation.x = -Math.PI / 2
    this.tag.position.set(0, 0.02, -0.95)
    this.root.add(this.tag)

    this.seatPosition = new THREE.Vector3(spot.x, 0, spot.z - 0.95)

    /* 拾取用包围盒 */
    this.hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 1.5, 2.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    this.hitbox.position.set(0, 0.75, -0.35)
    this.hitbox.userData.deskIndex = index
    this.root.add(this.hitbox)

    this.setOccupant(undefined)
  }

  get hasOccupant(): boolean {
    return this.occupant !== undefined
  }

  get occupantId(): string | undefined {
    return this.occupant === undefined ? undefined : this.occupant.name
  }

  setOccupant(occupant: DeskOccupant | undefined): void {
    this.occupant = occupant
    const nameTexture =
      occupant === undefined
        ? this.openPlateTexture()
        : textTexture(
            [
              { text: occupant.name, size: 32, weight: 700, align: 'center' },
              {
                text: PHASE_CAPTION[this.phase] ?? '',
                size: 15,
                weight: 500,
                mono: true,
                align: 'center',
              },
            ],
            { w: 384, h: 128, bg: '#f2e7d1', rule: false, pad: 14 },
          )
    this.swapTexture(this.plate, nameTexture)

    const paperTexture =
      occupant === undefined ? this.openPaperTexture() : this.taskPaperTexture(occupant)
    this.swapTexture(this.paper, paperTexture)

    this.tag.visible = occupant === undefined
  }

  setPhase(phase: ScenePhase): void {
    this.phase = phase
    this.clothMaterial.color.setHex(phaseTone(this.materials.paletteNow, phase))
    this.bulb.intensity = phase === 'paused' ? 0.5 : phase === 'failed' ? 0.3 : 2.6
    this.shadeMaterial.color.setHex(
      phase === 'failed' ? this.materials.paletteNow.bad : this.materials.paletteNow.accent,
    )
    this.shadeMaterial.emissiveIntensity =
      phase === 'failed' ? 0.06 : phase === 'paused' ? 0.1 : 0.28
    if (this.occupant !== undefined) this.setOccupant(this.occupant)
  }

  /** 折桌/弹桌：0 = 折叠（只剩蓝图），1 = 完全展开。 */
  setDeployed(amount: number): void {
    const clamped = Math.max(0, Math.min(1, amount))
    this.furniture.scale.y = 0.06 + 0.94 * clamped
    this.furniture.visible = clamped > 0.02
    this.blueprint.visible = clamped < 0.98
    this.ticks.visible = clamped < 0.98
    this.tag.visible = clamped > 0.5 && this.occupant === undefined
  }

  setTheme(): void {
    this.blueprintMaterial.color.setHex(this.materials.paletteNow.accent)
    this.ticksMaterial.color.setHex(this.materials.paletteNow.accent)
    this.bulb.color.setHex(this.materials.paletteNow.lampWarm)
    this.clothMaterial.color.setHex(phaseTone(this.materials.paletteNow, this.phase))
  }

  dispose(): void {
    ;(this.plate.material as THREE.MeshLambertMaterial).map?.dispose()
    ;(this.paper.material as THREE.MeshLambertMaterial).map?.dispose()
    ;(this.tag.material as THREE.MeshLambertMaterial).map?.dispose()
    this.blueprintMaterial.dispose()
    this.ticksMaterial.dispose()
    this.clothMaterial.dispose()
    this.shadeMaterial.dispose()
  }

  private swapTexture(mesh: THREE.Mesh, texture: THREE.Texture): void {
    const material = mesh.material as THREE.MeshLambertMaterial
    material.map?.dispose()
    material.map = texture
    material.needsUpdate = true
  }

  private openPlateTexture(): THREE.Texture {
    return textTexture(
      [
        { text: 'OPEN DESK', size: 34, weight: 700, align: 'center' },
        { text: 'hubagent agent add', size: 15, weight: 400, mono: true, align: 'center' },
      ],
      { w: 384, h: 128, bg: '#f2e7d1', rule: false, pad: 14 },
    )
  }

  private openPaperTexture(): THREE.Texture {
    return textTexture(
      [
        {
          text: `D${this.index + 1}`,
          size: 17,
          weight: 500,
          mono: true,
          color: 'rgba(43,36,28,.45)',
        },
        { text: 'unassigned', size: 26, weight: 600, color: 'rgba(43,36,28,.32)' },
      ],
      { w: 256, h: 160, bg: '#f7efdd', rule: false, pad: 16 },
    )
  }

  private taskPaperTexture(occupant: DeskOccupant): THREE.Texture {
    const step =
      occupant.step !== undefined && occupant.steps !== undefined
        ? `step ${occupant.step}/${occupant.steps}`
        : 'step —'
    const attempt = occupant.attempt !== undefined ? `attempt ${occupant.attempt}` : ''
    return textTexture(
      [
        { text: 'TASK', size: 15, weight: 500, mono: true, color: 'rgba(43,36,28,.45)' },
        { text: occupant.taskTitle ?? 'Waiting for dispatch', size: 23, weight: 600, gap: 1.35 },
        {
          text: occupant.subtaskTitle ?? 'no subtask yet',
          size: 14,
          weight: 400,
          mono: true,
          color: 'rgba(43,36,28,.55)',
          gap: 1.3,
        },
        {
          text: [step, attempt].filter((part) => part !== '').join(' · '),
          size: 13,
          weight: 400,
          mono: true,
          color: 'rgba(43,36,28,.5)',
        },
      ],
      { w: 320, h: 200, bg: '#f7efdd', rule: false, pad: 16 },
    )
  }
}
