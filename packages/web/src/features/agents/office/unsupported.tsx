import { Button } from '../../../components/ui/Button'
import type { PreflightFailure } from './preflight'
import type { OfficeTranslate } from './strings'

export interface UnsupportedProps {
  reason: PreflightFailure
  detail: string | undefined
  renderer: string | undefined
  t: OfficeTranslate
}

const TITLES: Record<PreflightFailure, string> = {
  forced: 'Blocked state (QA)',
  'no-webgl2': 'This floor needs WebGL2',
  'context-error': 'WebGL2 could not start',
  'three-load': 'The 3D engine could not load',
  'init-failed': 'The floor could not start',
  'context-lost': 'The GPU context was lost',
}

const WHY: Record<PreflightFailure, string> = {
  forced: 'Opened with ?unsupported=1 to review the blocked state.',
  'no-webgl2': 'canvas.getContext("webgl2") is unavailable, so the floor cannot be drawn.',
  'context-error': 'Creating a WebGL2 context threw an error.',
  'three-load': 'The 3D engine chunk failed to load.',
  'init-failed': 'The 3D engine started but the scene could not be built.',
  'context-lost': 'The GPU context was lost while the floor was running.',
}

/**
 * 阻断卡（§4.3）：WebGL2 不可用时只显示它——不加载办公室、不显示 2D 名单。
 * 明确写出「没有 2D 回退」，并给 CLI 路径。角色是 alert（阻断而非可忽略提示）。
 */
export function Unsupported(props: UnsupportedProps) {
  const diagnostics = (): string =>
    [
      `reason      ${props.reason}`,
      `webgl2      ${props.reason === 'no-webgl2' ? 'missing' : 'probe failed'}`,
      `detail      ${props.detail ?? 'n/a'}`,
      `renderer    ${props.renderer ?? 'not available'}`,
      `platform    ${navigator.platform || 'unknown'}`,
      `at          ${new Date().toISOString()}`,
    ].join('\n')

  return (
    <div
      class="absolute inset-0 z-20 grid place-items-center bg-canvas/95 p-4"
      role="alert"
      aria-live="assertive"
    >
      <div class="w-full max-w-lg rounded-panel border border-line-strong bg-surface p-6 shadow-dialog">
        <div class="mb-3 h-1 rounded bg-warning" aria-hidden="true" />
        <h2 class="text-title text-ink">{TITLES[props.reason]}</h2>
        <p class="mt-1.5 text-meta text-ink-2">{WHY[props.reason]}</p>

        <p class="mt-3 rounded-control border border-danger bg-danger-soft px-2.5 py-2 text-badge text-danger">
          <strong>No 2D fallback.</strong> The Agents page is 3D-only; there is no list or table
          view to switch to.
        </p>

        <pre class="mt-3 overflow-x-auto rounded-control bg-canvas px-3 py-2 font-mono text-badge text-ink-2">
          {diagnostics()}
        </pre>

        <div class="mt-3 flex items-center gap-2 rounded-control bg-ink px-3 py-2 font-mono text-badge text-canvas">
          <span class="opacity-60">CLI</span>
          <span>hubagent agents</span>
        </div>

        <div class="mt-4 flex gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            {props.t('retry')}
          </Button>
        </div>
      </div>
    </div>
  )
}
