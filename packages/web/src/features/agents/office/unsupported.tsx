import { Button } from '../../../components/ui/Button'
import type { PreflightFailure } from './preflight'
import type { OfficeKey, OfficeTranslate } from './strings'

export interface UnsupportedProps {
  reason: PreflightFailure
  detail: string | undefined
  renderer: string | undefined
  t: OfficeTranslate
}

const WHY: Record<PreflightFailure, OfficeKey> = {
  forced: 'unsupportedWhyForced',
  'no-webgl2': 'unsupportedWhyNoWebgl2',
  'context-error': 'unsupportedWhyContextError',
  'three-load': 'unsupportedWhyThreeLoad',
  'init-failed': 'unsupportedWhyInitFailed',
  'context-lost': 'unsupportedWhyContextLost',
}

/**
 * 阻断卡（§4.3）：WebGL2 不可用时只显示它——不加载办公室、不显示 2D 名单。
 * 明确写出「没有 2D 回退」，并给 CLI 路径。角色是 alert（阻断而非可忽略提示）。
 */
export function Unsupported(props: UnsupportedProps) {
  const diagnostics = (): string =>
    [
      `reason      ${props.reason}`,
      `webgl2      ${
        props.reason === 'no-webgl2'
          ? 'missing'
          : props.reason === 'forced'
            ? 'skipped (?unsupported=1)'
            : 'probe failed'
      }`,
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
        <h2 class="text-title text-ink">{props.t('unsupportedTitle')}</h2>
        <p class="mt-1.5 text-meta text-ink-2">{props.t(WHY[props.reason])}</p>

        <p class="mt-3 rounded-control border border-danger bg-danger-soft px-2.5 py-2 text-badge text-danger">
          {props.t('unsupportedNoFallback')}
        </p>

        <div class="mt-3">
          <p class="text-badge font-semibold text-ink-3">{props.t('unsupportedDiagnostics')}</p>
          <pre class="mt-1 overflow-x-auto rounded-control border border-line bg-subtle px-3 py-2 font-mono text-badge text-ink-2">
            {diagnostics()}
          </pre>
        </div>

        <p class="mt-3 text-badge text-ink-3">{props.t('unsupportedCli')}</p>
        <div class="mt-1 flex items-center gap-2 rounded-control bg-ink px-3 py-2 font-mono text-badge text-canvas">
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
