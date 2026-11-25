import * as THREE from 'three'
import { BENCH, FLOOR_DEPTH, FLOOR_WIDTH } from '../layout'
import { contactShadow, paperMaterial, textTexture } from './textures'
import type { MaterialCache } from './theme'

export interface RoomBuild {
  group: THREE.Group
  /** 门板铰链：场景在进场/离场时转动它。 */
  doorHinge: THREE.Group
  /** 主题切换：更新不走材质缓存的网格/玻璃颜色。 */
  applyTheme: (materials: MaterialCache) => void
}

/**
 * 房间：地板/网格/两面墙/窗/门/DONE 墙/计划板/调度台/植物/便签。
 * 窗、植物只做氛围，不承载状态（§2.1）。
 */
export function buildRoom(materials: MaterialCache): RoomBuild {
  const group = new THREE.Group()

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(FLOOR_WIDTH, 0.3, FLOOR_DEPTH),
    materials.mat('floor'),
  )
  floor.position.y = -0.15
  group.add(floor)

  const points: number[] = []
  for (let x = -FLOOR_WIDTH / 2; x <= FLOOR_WIDTH / 2 + 0.001; x += 1.1875) {
    points.push(x, 0.012, -FLOOR_DEPTH / 2, x, 0.012, FLOOR_DEPTH / 2)
  }
  for (let z = -FLOOR_DEPTH / 2; z <= FLOOR_DEPTH / 2 + 0.001; z += 1.1666) {
    points.push(-FLOOR_WIDTH / 2, 0.012, z, FLOOR_WIDTH / 2, 0.012, z)
  }
  const gridGeometry = new THREE.BufferGeometry()
  gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const gridMaterial = new THREE.LineBasicMaterial({
    color: materials.paletteNow.grid,
    transparent: true,
    opacity: 0.7,
  })
  group.add(new THREE.LineSegments(gridGeometry, gridMaterial))

  const back = new THREE.Mesh(new THREE.BoxGeometry(FLOOR_WIDTH, 3.5, 0.26), materials.mat('wall'))
  back.position.set(0, 1.75, -FLOOR_DEPTH / 2 - 0.13)
  group.add(back)

  const left = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.5, FLOOR_DEPTH), materials.mat('wall'))
  left.position.set(-FLOOR_WIDTH / 2 - 0.13, 1.75, 0)
  group.add(left)

  /* 窗（后墙） */
  const winFrame = new THREE.Mesh(new THREE.BoxGeometry(4.0, 1.6, 0.12), materials.mat('wallTop'))
  winFrame.position.set(-1.5, 1.85, -FLOOR_DEPTH / 2 + 0.01)
  group.add(winFrame)
  const glassMaterial = new THREE.MeshBasicMaterial({
    color: materials.paletteNow.glass,
    transparent: true,
    opacity: 0.9,
  })
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.68, 1.32), glassMaterial)
  glass.position.set(-1.5, 1.85, -FLOOR_DEPTH / 2 + 0.075)
  group.add(glass)

  /* 门（左墙） */
  const opening = new THREE.Mesh(new THREE.PlaneGeometry(1.86, 2.16), materials.mat('wallTop'))
  opening.rotation.y = Math.PI / 2
  opening.position.set(-FLOOR_WIDTH / 2 + 0.04, 1.08, -2.2)
  group.add(opening)

  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 2.1), materials.mat('deskEdge'))
  doorFrame.position.set(-FLOOR_WIDTH / 2 + 0.06, 2.2, -2.2)
  group.add(doorFrame)

  const doorHinge = new THREE.Group()
  doorHinge.position.set(-FLOOR_WIDTH / 2 + 0.08, 0, -2.2 - 0.93)
  group.add(doorHinge)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 2.08, 1.84), materials.mat('deskTop'))
  panel.position.set(0, 1.04, 0.93)
  doorHinge.add(panel)

  /* DONE 墙（后左） */
  const doneTexture = textTexture(
    [
      { text: 'DONE', size: 58, weight: 700 },
      { text: 'shipped work, with evidence', size: 20, weight: 400, mono: true },
    ],
    { w: 640, h: 320, bg: '#f6edda', stripe: '#527f59', pad: 34 },
  )
  const doneBoard = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, 1.85, 0.09),
    paperMaterial(doneTexture),
  )
  doneBoard.position.set(-6.5, 1.62, -FLOOR_DEPTH / 2 + 0.1)
  group.add(doneBoard)
  const doneFrame = new THREE.Mesh(
    new THREE.BoxGeometry(3.7, 2.05, 0.05),
    materials.mat('deskEdge'),
  )
  doneFrame.position.set(-6.5, 1.62, -FLOOR_DEPTH / 2 + 0.05)
  group.add(doneFrame)

  /* 计划板（左墙，门旁） */
  const planTexture = textTexture(
    [
      { text: 'TODAY', size: 42, weight: 700 },
      { text: 'plan · dispatch · verify', size: 22, weight: 400, mono: true, gap: 1.35 },
      { text: 'real work only', size: 22, weight: 400, mono: true, gap: 1.35 },
    ],
    { w: 640, h: 384, bg: '#f4ead6', stripe: '#bd6428', pad: 32 },
  )
  const planBoard = new THREE.Mesh(
    new THREE.BoxGeometry(3.7, 2.2, 0.09),
    paperMaterial(planTexture),
  )
  planBoard.rotation.y = Math.PI / 2
  planBoard.position.set(-FLOOR_WIDTH / 2 + 0.14, 1.78, 2.4)
  group.add(planBoard)
  const planFrame = new THREE.Mesh(new THREE.BoxGeometry(3.9, 2.4, 0.05), materials.mat('deskEdge'))
  planFrame.rotation.y = Math.PI / 2
  planFrame.position.set(-FLOOR_WIDTH / 2 + 0.09, 1.78, 2.4)
  group.add(planFrame)

  /* 调度台（前左） */
  const hub = new THREE.Group()
  hub.position.set(-5.3, 0, 4.1)
  group.add(hub)
  const hubBody = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.86, 0.95), materials.mat('deskTop'))
  hubBody.position.y = 0.43
  hub.add(hubBody)
  const hubScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.52),
    paperMaterial(
      textTexture(
        [
          { text: 'DISPATCH', size: 30, weight: 700 },
          { text: 'real queue only', size: 17, weight: 400, mono: true },
        ],
        { w: 512, h: 176, bg: '#2b241c', ink: '#f4ead6', rule: false, pad: 20 },
      ),
    ),
  )
  hubScreen.position.set(0, 1.32, -0.2)
  hubScreen.rotation.x = -0.32
  hub.add(hubScreen)
  hub.add(contactShadow(2.5, 1.5, 0.45))

  /* 等候位：右墙一排长凳 + 地垫（§2.1 bench） */
  const bench = new THREE.Group()
  group.add(bench)
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 6.6),
    new THREE.MeshLambertMaterial({
      color: materials.paletteNow.cushion,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  )
  rug.rotation.x = -Math.PI / 2
  rug.position.set(7.6, 0.014, 0)
  bench.add(rug)
  for (const seatSpot of BENCH) {
    const seat = new THREE.Group()
    seat.position.set(seatSpot.x, 0, seatSpot.z)
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.07, 12),
      materials.mat('cushion'),
    )
    pad.position.y = 0.44
    seat.add(pad)
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8),
      materials.mat('metal'),
    )
    post.position.y = 0.22
    seat.add(post)
    seat.add(contactShadow(0.62, 0.62, 0.26))
    bench.add(seat)
  }

  /* 植物（前右） */
  const plant = new THREE.Group()
  plant.position.set(7.7, 0, 4.4)
  group.add(plant)
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.19, 0.36, 10), materials.mat('pot'))
  pot.position.y = 0.18
  plant.add(pot)
  for (let index = 0; index < 6; index += 1) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 6), materials.mat('plant'))
    const angle = (index / 6) * Math.PI * 2
    leaf.position.set(Math.cos(angle) * 0.17, 0.44 + (index % 3) * 0.13, Math.sin(angle) * 0.17)
    leaf.scale.set(1, 0.82, 1)
    plant.add(leaf)
  }
  plant.add(contactShadow(0.9, 0.9, 0.35))

  return {
    group,
    doorHinge,
    applyTheme: (cache: MaterialCache): void => {
      gridMaterial.color.setHex(cache.paletteNow.grid)
      glassMaterial.color.setHex(cache.paletteNow.glass)
    },
  }
}
