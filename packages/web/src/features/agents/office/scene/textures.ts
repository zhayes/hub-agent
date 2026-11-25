import * as THREE from 'three'

/**
 * 程序化纹理：nameplate / task / plan / done / DONE 墙都来自 canvas，不引入图片资源。
 * 文字内容只放真实字段（任务标题、子任务、步骤）；没有数据就给中性占位（§3.4）。
 */

export interface TextLine {
  text: string
  size?: number
  weight?: number
  mono?: boolean
  align?: 'left' | 'center' | 'right'
  color?: string
  gap?: number
}

export interface TextureOptions {
  w?: number
  h?: number
  bg?: string
  ink?: string
  rule?: boolean
  ruleColor?: string
  stripe?: string
  pad?: number
}

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif'
const MONO = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

export function textTexture(
  lines: readonly TextLine[],
  options: TextureOptions = {},
): THREE.CanvasTexture {
  const width = options.w ?? 512
  const height = options.h ?? 256
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context !== null) {
    context.fillStyle = options.bg ?? '#fdf7ea'
    context.fillRect(0, 0, width, height)
    if (options.rule !== false) {
      context.strokeStyle = options.ruleColor ?? 'rgba(43,36,28,.16)'
      context.lineWidth = 2
      context.strokeRect(6, 6, width - 12, height - 12)
    }
    if (options.stripe !== undefined) {
      context.fillStyle = options.stripe
      context.fillRect(0, 0, width, 12)
    }
    const pad = options.pad ?? 26
    let y = pad + 8
    for (const line of lines) {
      const size = line.size ?? 34
      context.fillStyle = line.color ?? options.ink ?? '#2b241c'
      context.font = `${line.weight ?? 600} ${size}px ${line.mono === true ? MONO : SERIF}`
      context.textAlign = line.align ?? 'left'
      context.textBaseline = 'top'
      const x = line.align === 'center' ? width / 2 : line.align === 'right' ? width - pad : pad
      context.fillText(line.text, x, y, width - pad * 2)
      y += size * (line.gap ?? 1.45)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

export function paperMaterial(texture: THREE.Texture): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide })
}

let shadow: THREE.CanvasTexture | undefined

/** 接触阴影贴图（单例）。 */
export function shadowTexture(): THREE.CanvasTexture {
  if (shadow !== undefined) return shadow
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context !== null) {
    const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 62)
    gradient.addColorStop(0, 'rgba(0,0,0,.42)')
    gradient.addColorStop(0.55, 'rgba(0,0,0,.16)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
  }
  shadow = new THREE.CanvasTexture(canvas)
  return shadow
}

export function contactShadow(width: number, depth: number, opacity = 0.5): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0.012
  return mesh
}

export function edgeLines(
  geometry: THREE.BufferGeometry,
  color: number,
  opacity = 0.5,
): THREE.LineSegments {
  const edges = new THREE.EdgesGeometry(geometry, 32)
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
  })
  return new THREE.LineSegments(edges, material)
}
