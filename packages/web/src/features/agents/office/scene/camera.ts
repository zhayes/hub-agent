import * as THREE from 'three'
import type { CameraPreset } from '../contracts'
import { CAMERA_POSITION, CAMERA_PRESETS } from '../layout'

/**
 * 正交等距相机 + 预设 + 点击聚焦（§1.2 固定等距，不做自由 orbit / 第一人称）。
 * 目标值与当前值分离，逐帧缓动，避免镜头瞬移。
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera
  private width = 1
  private height = 1
  private desiredSize: number
  private desiredTarget: THREE.Vector3
  private currentSize: number
  private currentTarget: THREE.Vector3
  private readonly position = new THREE.Vector3(
    CAMERA_POSITION.x,
    CAMERA_POSITION.y,
    CAMERA_POSITION.z,
  )

  constructor(preset: CameraPreset = 'overview') {
    const config = CAMERA_PRESETS[preset]
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -60, 120)
    this.desiredSize = config.size
    this.currentSize = config.size
    this.desiredTarget = new THREE.Vector3(config.target.x, config.lift, config.target.z)
    this.currentTarget = this.desiredTarget.clone()
    this.apply()
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.apply()
  }

  setPreset(preset: CameraPreset): void {
    const config = CAMERA_PRESETS[preset]
    this.desiredSize = config.size
    this.desiredTarget = new THREE.Vector3(config.target.x, config.lift, config.target.z)
  }

  focusOn(point: { x: number; z: number }): void {
    this.desiredSize = 7.2
    this.desiredTarget = new THREE.Vector3(point.x, 1.1, point.z)
  }

  resetZoom(): void {
    this.desiredSize = CAMERA_PRESETS.overview.size
  }

  update(delta: number, reduced: boolean): void {
    if (reduced) {
      this.currentSize = this.desiredSize
      this.currentTarget.copy(this.desiredTarget)
      this.apply()
      return
    }
    const k = 1 - Math.exp(-delta * 6)
    this.currentSize += (this.desiredSize - this.currentSize) * k
    this.currentTarget.lerp(this.desiredTarget, k)
    this.apply()
  }

  private apply(): void {
    const aspect = this.width / this.height
    const effective =
      aspect >= 1.25 ? this.currentSize : Math.min(this.currentSize, 8.6 + 2.4 * aspect)
    const halfHeight = effective / 2
    const halfWidth = halfHeight * aspect
    this.camera.left = -halfWidth
    this.camera.right = halfWidth
    this.camera.top = halfHeight
    this.camera.bottom = -halfHeight
    this.camera.position.copy(this.position)
    this.camera.lookAt(this.currentTarget)
    this.camera.updateProjectionMatrix()
  }
}
