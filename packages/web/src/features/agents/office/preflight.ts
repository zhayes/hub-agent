/**
 * WebGL2 预检（PLAN-AGENT-OFFICE §4.3）。
 *
 * 通过才允许 `import('./scene/scene')`；失败/超时/抛错一律阻断，**不降级为 2D**，
 * 也不在未通过预检时下载 three chunk。
 */

export type PreflightFailure =
  | 'forced'
  | 'no-webgl2'
  | 'context-error'
  | 'three-load'
  | 'init-failed'
  | 'context-lost'

export interface PreflightResult {
  ok: boolean
  reason?: PreflightFailure
  detail?: string
  renderer?: string
}

export function preflightWebgl2(forceUnsupported: boolean): PreflightResult {
  if (forceUnsupported) {
    return { ok: false, reason: 'forced', detail: '?unsupported=1' }
  }

  let gl: WebGL2RenderingContext | null = null
  try {
    gl = document.createElement('canvas').getContext('webgl2')
  } catch (error) {
    return {
      ok: false,
      reason: 'context-error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (gl === null) {
    let detail = 'canvas.getContext("webgl2") returned null'
    try {
      const probe = document.createElement('canvas')
      const webgl1 = probe.getContext('webgl')
      detail += webgl1 ? ' · WebGL1 present, WebGL2 missing' : ' · no WebGL context at all'
    } catch {
      // ignore probe failure
    }
    return { ok: false, reason: 'no-webgl2', detail }
  }

  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer =
    debug !== null
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
  return { ok: true, renderer }
}

/** 是否通过 URL 强制进入 unsupported（仅供 preview/QA 截图，不是产品功能）。 */
export function forcedUnsupported(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('unsupported') === '1'
  } catch {
    return false
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
