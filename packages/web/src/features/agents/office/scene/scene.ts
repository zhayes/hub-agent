import * as THREE from 'three'
import type {
  SceneAgent,
  SceneController,
  SceneMountOptions,
  ScenePhase,
  SceneSnapshot,
} from '../contracts'
import { benchPosition, DOOR_OUTSIDE, deskPosition, FLOOR_DEPTH } from '../layout'
import { Figure, figureConfigFor } from './agent'
import { CameraRig } from './camera'
import { isFinishing } from './choreography'
import { Desk } from './desk'
import { buildRoom } from './room'
import { paperMaterial, textTexture } from './textures'
import { MaterialCache, PALETTES } from './theme'

/**
 * 唯一 three 入口（PLAN-AGENT-OFFICE §4.2 / §4.3）。
 *
 * 只被 stage-entry 在 WebGL2 预检通过后动态 import；本文件之外不得 import three。
 * 场景只「指」不「决」：不存在审批/写操作，姿态与动画只表现 presence 事实。
 */

const MOVE_SPEED = 2.2 // 世界单位/秒
const DEPLOY_SPEED = 3.2

type Arrival = 'desk' | 'bench' | 'wait' | 'door' | 'none'

interface FigureEntry {
  id: string
  figure: Figure
  phase: ScenePhase
  deskIndex?: number
  target: THREE.Vector3
  arrival: Arrival
  moving: boolean
  walkPhase: number
  leaving: boolean
}

interface Tween {
  elapsed: number
  duration: number
  update: (progress: number) => void
  done?: () => void
}

export function mountScene(canvas: HTMLCanvasElement, options: SceneMountOptions): SceneController {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const materials = new MaterialCache(options.theme)
  renderer.setClearColor(PALETTES[options.theme].floor, 1)

  const room = buildRoom(materials)
  scene.add(room.group)

  const desks = Array.from({ length: 8 }, (_, index) => new Desk(index, materials))
  for (const desk of desks) scene.add(desk.root)

  const hemi = new THREE.HemisphereLight(0xfff4e2, 0x6b5a44, options.theme === 'dark' ? 0.5 : 1.05)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff0d6, options.theme === 'dark' ? 0.55 : 1.15)
  sun.position.set(7, 12, 9)
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0xcfd8e6, options.theme === 'dark' ? 0.22 : 0.35)
  fill.position.set(-8, 6, -6)
  scene.add(fill)

  const rig = new CameraRig('overview')
  const figures = new Map<string, FigureEntry>()
  const tweens: Tween[] = []
  const deploy = new Array<number>(desks.length).fill(0)
  const pinned: THREE.Object3D[] = []

  let reducedMotion = options.reducedMotion
  let theme = options.theme
  let doorOpenUntil = 0
  let disposed = false
  let frame = 0
  let lastTime = performance.now()

  /* ---------- 尺寸 ---------- */
  function resize(): void {
    const width = canvas.clientWidth || canvas.width || 1
    const height = canvas.clientHeight || canvas.height || 1
    renderer.setSize(width, height, false)
    rig.setViewport(width, height)
  }

  /* ---------- 主题 ---------- */
  function applyTheme(next: 'light' | 'dark'): void {
    theme = next
    materials.recolor(next)
    const palette = PALETTES[next]
    renderer.setClearColor(palette.floor, 1)
    hemi.intensity = next === 'dark' ? 0.5 : 1.05
    sun.intensity = next === 'dark' ? 0.55 : 1.15
    fill.intensity = next === 'dark' ? 0.22 : 0.35
    room.applyTheme(materials)
    for (const desk of desks) desk.setTheme()
  }

  /* ---------- 走位 ---------- */
  function doorTarget(time: number): number {
    return time < doorOpenUntil ? -1.15 : 0
  }

  function seatPositionOf(agent: SceneAgent): { position: THREE.Vector3; arrival: Arrival } {
    if (agent.phase === 'off-floor') {
      return { position: outsidePosition(), arrival: 'door' }
    }
    if (agent.deskIndex !== undefined) {
      return { position: desks[agent.deskIndex].seatPosition.clone(), arrival: 'desk' }
    }
    if (agent.benchIndex !== undefined) {
      const seat = benchPosition(agent.benchIndex)
      return { position: new THREE.Vector3(seat.x - 0.28, 0, seat.z), arrival: 'bench' }
    }
    // 容量不足：站在门内侧，HUD 显示 floor full
    return { position: new THREE.Vector3(DOOR_OUTSIDE.x + 2.4, 0, DOOR_OUTSIDE.z), arrival: 'wait' }
  }

  function outsidePosition(): THREE.Vector3 {
    return new THREE.Vector3(DOOR_OUTSIDE.x, 0, DOOR_OUTSIDE.z)
  }

  function spawn(agent: SceneAgent): void {
    const figure = new Figure(figureConfigFor(agent.id), materials)
    figure.root.position.copy(outsidePosition())
    figure.root.rotation.y = Math.PI / 2
    scene.add(figure.root)
    const seat = seatPositionOf(agent)
    figures.set(agent.id, {
      id: agent.id,
      figure,
      phase: agent.phase,
      ...(agent.deskIndex === undefined ? {} : { deskIndex: agent.deskIndex }),
      target: seat.position,
      arrival: seat.arrival,
      moving: true,
      walkPhase: 0,
      leaving: false,
    })
    doorOpenUntil = performance.now() + 1000
    if (reducedMotion) arrive(agent.id)
  }

  function arrive(id: string): void {
    const entry = figures.get(id)
    if (entry === undefined) return
    entry.moving = false
    if (entry.arrival === 'door') {
      removeFigure(id)
      return
    }
    if (entry.arrival === 'desk' || entry.arrival === 'bench') {
      entry.figure.setSeated(true)
      if (entry.arrival === 'desk' && entry.deskIndex !== undefined) {
        const spot = deskPosition(entry.deskIndex)
        entry.figure.faceTo(spot.x, spot.z + 2)
      } else {
        entry.figure.root.rotation.y = -Math.PI / 2
      }
    } else {
      entry.figure.setSeated(false)
    }
  }

  function removeFigure(id: string): void {
    const entry = figures.get(id)
    if (entry === undefined) return
    scene.remove(entry.figure.root)
    entry.figure.dispose()
    figures.delete(id)
  }

  function updateEntry(entry: FigureEntry, agent: SceneAgent): void {
    const finishing = isFinishing(entry.phase, agent.phase)
    entry.phase = agent.phase
    if (agent.deskIndex !== undefined) entry.deskIndex = agent.deskIndex

    if (finishing) celebrate(agent)

    const seat = seatPositionOf(agent)
    const moved = seat.arrival !== entry.arrival || entry.target.distanceTo(seat.position) > 0.01
    entry.target.copy(seat.position)
    entry.arrival = seat.arrival
    entry.leaving = seat.arrival === 'door'

    // 只有座位真的变了才重新走位；重复快照只换任务牌/姿态，不重弹桌、不抖动（§2.3 / G3）。
    if (moved) {
      entry.moving = true
      entry.figure.setSeated(false)
      if (seat.arrival === 'door') doorOpenUntil = performance.now() + 1000
      if (reducedMotion) arrive(entry.id)
    } else if (!entry.moving) {
      applyPose(entry)
    }
  }

  /* ---------- 完成瞬态：盖章 + 票据飞向 DONE 墙 ---------- */
  function celebrate(agent: SceneAgent): void {
    const origin =
      agent.deskIndex !== undefined
        ? desks[agent.deskIndex].seatPosition
        : new THREE.Vector3(6, 0, 0)
    const stamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.1, 0.16),
      new THREE.MeshLambertMaterial({ color: PALETTES[theme].bad }),
    )
    stamp.position.set(origin.x + 0.25, 1.5, origin.z + 0.9)
    scene.add(stamp)
    runTween(240, (progress) => {
      stamp.position.y = 1.5 - 0.72 * progress
    })
    runTween(
      220,
      (progress) => {
        stamp.position.y = 0.82 + 0.5 * progress
        stamp.scale.setScalar(1 - 0.4 * progress)
      },
      () => {
        scene.remove(stamp)
        flyTicket(agent, origin)
      },
    )
  }

  function flyTicket(agent: SceneAgent, origin: THREE.Vector3): void {
    const title = agent.finishedTaskTitle ?? agent.taskTitle ?? 'task'
    const texture = textTexture(
      [
        { text: 'DONE', size: 20, weight: 700, mono: true, color: '#527f59' },
        { text: title, size: 24, weight: 600, gap: 1.5 },
      ],
      { w: 320, h: 200, bg: '#fdf7ea', pad: 18, stripe: '#527f59' },
    )
    const ticket = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), paperMaterial(texture))
    const start = new THREE.Vector3(origin.x + 0.2, 1.1, origin.z + 0.6)
    ticket.position.copy(start)
    scene.add(ticket)
    const slot = pinned.length % 4
    const end = new THREE.Vector3(
      -7.4 + (slot % 2) * 0.95,
      1.95 - Math.floor(slot / 2) * 0.6,
      -FLOOR_DEPTH / 2 + 0.2,
    )
    const mid = new THREE.Vector3((start.x + end.x) / 2 - 1.2, 3.0, (start.z + end.z) / 2 + 0.6)
    runTween(
      900,
      (progress) => {
        const a = new THREE.Vector3().lerpVectors(start, mid, progress)
        const b = new THREE.Vector3().lerpVectors(mid, end, progress)
        ticket.position.lerpVectors(a, b, progress)
        ticket.rotation.z = Math.sin(progress * Math.PI) * 0.5
        ticket.scale.setScalar(1 - 0.28 * progress)
      },
      () => {
        pinned.push(ticket)
        while (pinned.length > 4) {
          const old = pinned.shift()
          if (old !== undefined) {
            scene.remove(old)
          }
        }
      },
    )
  }

  /* ---------- tween ---------- */
  function runTween(duration: number, update: (progress: number) => void, done?: () => void): void {
    const actual = reducedMotion ? 16 : Math.max(1, duration)
    if (reducedMotion) {
      update(1)
      done?.()
      return
    }
    tweens.push({ elapsed: 0, duration: actual, update, ...(done === undefined ? {} : { done }) })
  }

  /* ---------- 快照 ---------- */
  function setSnapshot(snapshot: SceneSnapshot): void {
    const next = new Map<string, SceneAgent>()
    for (const agent of snapshot.agents) next.set(agent.id, agent)

    for (const [id, entry] of [...figures]) {
      const agent = next.get(id)
      if (agent === undefined || agent.phase === 'off-floor') {
        if (!entry.leaving) {
          entry.leaving = true
          entry.arrival = 'door'
          entry.target.copy(outsidePosition())
          entry.moving = true
          entry.figure.setSeated(false)
          doorOpenUntil = performance.now() + 1000
          if (reducedMotion) removeFigure(id)
        }
        continue
      }
      updateEntry(entry, agent)
    }

    for (const agent of snapshot.agents) {
      if (agent.phase === 'off-floor') continue
      if (!figures.has(agent.id)) spawn(agent)
    }

    /* 工位占用与阶段灯 */
    const owners = new Map<number, SceneAgent>()
    for (const agent of snapshot.agents) {
      if (agent.deskIndex !== undefined) owners.set(agent.deskIndex, agent)
    }
    for (let index = 0; index < desks.length; index += 1) {
      const desk = desks[index]
      const owner = owners.get(index)
      if (owner === undefined) {
        desk.setOccupant(undefined)
        desk.setPhase('off-floor')
      } else {
        desk.setOccupant({
          name: owner.name,
          ...(owner.taskTitle === undefined ? {} : { taskTitle: owner.taskTitle }),
          ...(owner.subtaskTitle === undefined ? {} : { subtaskTitle: owner.subtaskTitle }),
          ...(owner.step === undefined ? {} : { step: owner.step }),
          ...(owner.steps === undefined ? {} : { steps: owner.steps }),
          ...(owner.attempt === undefined ? {} : { attempt: owner.attempt }),
        })
        desk.setPhase(owner.phase)
      }
    }
  }

  /* ---------- 拾取 ---------- */
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  function onPointerDown(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, rig.camera)
    const hits = raycaster.intersectObjects(
      desks.map((desk) => desk.hitbox),
      false,
    )
    const first = hits[0]
    if (first === undefined) {
      options.onSelect(null)
      return
    }
    const deskIndex = first.object.userData.deskIndex as number | undefined
    if (deskIndex === undefined) {
      options.onSelect(null)
      return
    }
    options.onSelect(deskIdAt(deskIndex))
  }

  function deskIdAt(index: number): string | null {
    for (const entry of figures.values()) {
      if (entry.deskIndex === index && entry.arrival === 'desk') return entry.id
    }
    return null
  }

  canvas.addEventListener('pointerdown', onPointerDown)

  /* ---------- 帧循环 ---------- */
  function step(now: number): void {
    if (disposed) return
    frame = requestAnimationFrame(step)
    const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000))
    lastTime = now
    if (document.hidden) return

    /* 相机 */
    rig.update(delta, reducedMotion)

    /* 门 */
    const hinge = room.doorHinge
    const targetAngle = doorTarget(now)
    hinge.rotation.y +=
      (targetAngle - hinge.rotation.y) * (reducedMotion ? 1 : 1 - Math.exp(-delta * 10))

    /* 走位 */
    for (const entry of figures.values()) {
      if (!entry.moving) {
        applyPose(entry)
        continue
      }
      const position = entry.figure.root.position
      const dx = entry.target.x - position.x
      const dz = entry.target.z - position.z
      const distance = Math.hypot(dx, dz)
      const stepLength = MOVE_SPEED * delta
      if (distance <= stepLength || distance < 0.001) {
        position.x = entry.target.x
        position.z = entry.target.z
        arrive(entry.id)
        continue
      }
      const nx = dx / distance
      const nz = dz / distance
      position.x += nx * stepLength
      position.z += nz * stepLength
      entry.figure.root.rotation.y = Math.atan2(nx, nz)
      entry.figure.setSeated(false)
      entry.walkPhase += stepLength * 7.5
      entry.figure.setWalkSwing(Math.sin(entry.walkPhase) * 0.5)
    }

    /* 工位展开 */
    const occupiedDesks = new Set<number>()
    for (const entry of figures.values()) {
      if (entry.deskIndex !== undefined) occupiedDesks.add(entry.deskIndex)
    }
    for (let index = 0; index < desks.length; index += 1) {
      const target = occupiedDesks.has(index) ? 1 : 0
      const current = deploy[index] ?? 0
      const next =
        current +
        Math.sign(target - current) * Math.min(Math.abs(target - current), DEPLOY_SPEED * delta)
      deploy[index] = reducedMotion ? target : next
      desks[index].setDeployed(reducedMotion ? target : next)
    }

    /* tweens */
    for (let index = tweens.length - 1; index >= 0; index -= 1) {
      const tween = tweens[index]
      if (tween === undefined) continue
      tween.elapsed += delta * 1000
      const progress = Math.min(1, tween.elapsed / tween.duration)
      tween.update(easeInOut(progress))
      if (progress >= 1) {
        tweens.splice(index, 1)
        tween.done?.()
      }
    }

    renderer.render(scene, rig.camera)
  }

  function applyPose(entry: FigureEntry): void {
    if (!entry.figure.isSeated) return
    const hand = entry.phase === 'needs-approval' || entry.phase === 'needs-input'
    entry.figure.raiseHand(hand)
    entry.figure.leanBack(entry.phase === 'paused')
  }

  function easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
  }

  resize()
  frame = requestAnimationFrame(step)

  return {
    setSnapshot,
    focusAgent: (id: string | null): void => {
      if (id === null) {
        rig.setPreset('overview')
        return
      }
      const entry = figures.get(id)
      if (entry === undefined) return
      rig.focusOn({ x: entry.figure.root.position.x, z: entry.figure.root.position.z })
    },
    setPreset: (preset): void => rig.setPreset(preset),
    setTheme: (next): void => applyTheme(next),
    setReducedMotion: (value: boolean): void => {
      reducedMotion = value
    },
    resize,
    dispose: (): void => {
      disposed = true
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onPointerDown)
      for (const entry of [...figures.values()]) {
        scene.remove(entry.figure.root)
        entry.figure.dispose()
      }
      figures.clear()
      for (const desk of desks) desk.dispose()
      materials.dispose()
      renderer.dispose()
    },
  }
}
