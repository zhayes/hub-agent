import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { useApp } from '../../../app/store'
import { Button } from '../../../components/ui/Button'
import { Icon } from '../../../components/ui/Icon'
import { type AgentPresence, api } from '../../../shared/api'
import type { CameraPreset, SceneController, SeatAllocation } from './contracts'
import {
  forcedUnsupported,
  type PreflightFailure,
  prefersReducedMotion,
  preflightWebgl2,
} from './preflight'
import {
  allocateSeats,
  attentionAgents,
  needsAttention,
  occupiesDesk,
  phaseOf,
  toSceneAgents,
} from './presence'
import { isFinishing } from './scene/choreography'
import { type OfficeKey, type OfficeTranslate, officeT } from './strings'
import { AttentionBanner } from './ui/attention-banner'
import { CallSheet } from './ui/call-sheet'
import { DispatchCard } from './ui/dispatch-card'
import { Drawer } from './ui/drawer'
import { Unsupported } from './unsupported'
import { createPresenceStore } from './use-presence'

type Mode = 'probing' | 'ready' | 'unsupported'

interface ViewState {
  agents: AgentPresence[]
  allocation: SeatAllocation
  finished: Record<string, string>
}

const CAMERA_LABELS: ReadonlyArray<[CameraPreset, OfficeKey]> = [
  ['overview', 'camOverview'],
  ['desks', 'camDesks'],
  ['entrance', 'camEntrance'],
  ['done', 'camDone'],
]

const PHASE_KEYS: Readonly<Record<string, OfficeKey>> = {
  'off-floor': 'statusOffFloor',
  standby: 'statusStandby',
  entering: 'statusEntering',
  working: 'statusWorking',
  'needs-approval': 'statusNeedsApproval',
  'needs-input': 'statusNeedsInput',
  paused: 'statusPaused',
  degraded: 'statusDegraded',
  failed: 'statusFailed',
}

const cameraActive = 'rounded-control bg-ink px-2 py-1 text-badge text-canvas'
const cameraIdle =
  'rounded-control px-2 py-1 text-badge text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function phaseLabel(t: OfficeTranslate, agent: AgentPresence): string {
  return t(PHASE_KEYS[phaseOf(agent)] ?? 'statusUnknown')
}

/**
 * `/agents` 的唯一视图：3D Dispatch Floor（PLAN-AGENT-OFFICE）。
 *
 * - 先做 WebGL2 预检；不通过只显示阻断卡，不 import three、不显示 2D 名单。
 * - 通过后动态加载 scene/，HUD 是 3D 视图的控制层。
 * - 数据只来自 presence 查询 + SSE 去抖刷新；审批只调用现有端点。
 */
export function StageEntry() {
  const app = useApp()
  const presence = createPresenceStore()
  const t = (): OfficeTranslate => officeT(app.locale())

  let canvasEl: HTMLCanvasElement | undefined
  let controller: SceneController | undefined

  const [mode, setMode] = createSignal<Mode>('probing')
  const [failure, setFailure] = createSignal<{
    reason: PreflightFailure
    detail?: string
    renderer?: string
  }>({ reason: 'init-failed' })
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [deciding, setDeciding] = createSignal(false)
  const [decideError, setDecideError] = createSignal('')
  const [cameraPreset, setCameraPreset] = createSignal<CameraPreset>('overview')
  const [keepDrawer, setKeepDrawer] = createSignal(false)
  const [reducedMotion, setReducedMotion] = createSignal(prefersReducedMotion())

  /* 稳定分配与上一份快照（用于选座与完成瞬态）；纯数据，不是响应式状态。 */
  let allocation: SeatAllocation = { desks: {}, bench: {}, unseated: [] }
  let previous = new Map<string, AgentPresence>()

  /* 数据 → 舞台模型。memo 只读 presence、不写信号；分配累积在闭包变量里。 */
  const view = createMemo<ViewState | undefined>(() => {
    const response = presence.data()
    if (response === undefined) return undefined
    const list = response.agents

    const finished: Record<string, string> = {}
    for (const agent of list) {
      const before = previous.get(agent.id)
      if (before === undefined) continue
      if (isFinishing(phaseOf(before), phaseOf(agent))) {
        const title = before.activity?.taskTitle ?? agent.activity?.taskTitle
        if (title !== undefined) finished[agent.id] = title
      }
    }

    allocation = allocateSeats(list, allocation)
    previous = new Map(list.map((agent) => [agent.id, agent]))
    return { agents: list, allocation, finished }
  })

  const agents = (): AgentPresence[] => view()?.agents ?? []
  const selected = (): AgentPresence | undefined => {
    const state = view()
    const id = selectedId()
    if (state === undefined || id === undefined) return undefined
    return state.agents.find((agent) => agent.id === id)
  }

  const resolvedTheme = (): 'light' | 'dark' => {
    const preference = app.theme.theme()
    if (preference === 'light' || preference === 'dark') return preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  /* 数据变化 → 场景快照（显式副作用，不做本地状态推断）。 */
  createEffect(
    () => view(),
    (state) => {
      if (state === undefined || controller === undefined) return
      controller.setSnapshot({
        agents: toSceneAgents(state.agents, state.allocation, state.finished),
      })
    },
  )

  /* 选中 → 镜头聚焦 */
  createEffect(
    () => selectedId(),
    (id) => {
      controller?.focusAgent(id ?? null)
    },
  )

  /* 主题 */
  createEffect(
    () => resolvedTheme(),
    (theme) => {
      controller?.setTheme(theme)
    },
  )

  /* 动效偏好 */
  createEffect(
    () => reducedMotion(),
    (value) => {
      controller?.setReducedMotion(value)
    },
  )

  /* ---------- 启动 ---------- */
  async function boot(): Promise<void> {
    if (canvasEl === undefined) return
    try {
      const module = await import('./scene/scene')
      if (canvasEl === undefined) return
      controller = module.mountScene(canvasEl, {
        theme: resolvedTheme(),
        reducedMotion: reducedMotion(),
        onSelect: (id) => setSelectedId(id ?? undefined),
      })
      const state = view()
      if (state !== undefined) {
        controller.setSnapshot({
          agents: toSceneAgents(state.agents, state.allocation, state.finished),
        })
      }
    } catch (error) {
      setFailure({
        reason: 'init-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      setMode('unsupported')
    }
  }

  function fail(reason: PreflightFailure, detail?: string): void {
    setFailure({ reason, ...(detail === undefined ? {} : { detail }) })
    setMode('unsupported')
  }

  const onContextLost = (event: Event): void => {
    event.preventDefault()
    controller?.dispose()
    controller = undefined
    setKeepDrawer(selectedId() !== undefined)
    fail('context-lost', 'webglcontextlost')
  }

  function jumpNext(): void {
    const list = attentionAgents(agents())
    if (list.length === 0) return
    const index = list.findIndex((agent) => agent.id === selectedId())
    const next = list[(index + 1) % list.length]
    if (next !== undefined) setSelectedId(next.id)
  }

  function selectAgent(agent: AgentPresence): void {
    setSelectedId(agent.id)
  }

  function chooseCamera(preset: CameraPreset): void {
    setCameraPreset(preset)
    controller?.setPreset(preset)
  }

  async function decide(approvalId: string, action: 'approve' | 'reject'): Promise<void> {
    setDeciding(true)
    setDecideError('')
    try {
      await (action === 'approve' ? api.approve(approvalId) : api.reject(approvalId))
      presence.refresh()
    } catch (cause) {
      setDecideError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeciding(false)
    }
  }

  onSettled(() => {
    if (canvasEl !== undefined) canvasEl.addEventListener('webglcontextlost', onContextLost)

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined' && canvasEl !== undefined) {
      observer = new ResizeObserver(() => controller?.resize())
      observer.observe(canvasEl)
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = (): void => {
      setReducedMotion(media.matches)
    }
    media.addEventListener('change', onMotion)

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'n' && event.key !== 'N') return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (mode() !== 'ready') return
      jumpNext()
    }
    window.addEventListener('keydown', onKey)

    const result = preflightWebgl2(forcedUnsupported())
    if (!result.ok) {
      setFailure({
        reason: result.reason ?? 'init-failed',
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      })
      setMode('unsupported')
      return () => {
        observer?.disconnect()
        media.removeEventListener('change', onMotion)
        window.removeEventListener('keydown', onKey)
        canvasEl?.removeEventListener('webglcontextlost', onContextLost)
      }
    }

    setFailure({
      reason: 'init-failed',
      ...(result.renderer === undefined ? {} : { renderer: result.renderer }),
    })
    setMode('ready')
    void boot()

    return () => {
      observer?.disconnect()
      media.removeEventListener('change', onMotion)
      window.removeEventListener('keydown', onKey)
      canvasEl?.removeEventListener('webglcontextlost', onContextLost)
      controller?.dispose()
      controller = undefined
    }
  })

  const attention = (): AgentPresence[] => attentionAgents(agents())
  const primary = (): AgentPresence | undefined =>
    attention()[0] ?? agents().find((agent) => phaseOf(agent) === 'working')
  const queue = (): AgentPresence[] =>
    agents()
      .filter((agent) => occupiesDesk(phaseOf(agent)) && agent.id !== primary()?.id)
      .slice(0, 3)
  const deskCount = (): number => Object.keys(view()?.allocation.desks ?? {}).length
  const benchCount = (): number => Object.keys(view()?.allocation.bench ?? {}).length
  const unseatedCount = (): number => view()?.allocation.unseated.length ?? 0
  const drawerVisible = (): boolean =>
    (mode() === 'ready' || keepDrawer()) && selected() !== undefined

  const bannerMessage = (): string => {
    const list = attention()
    if (list.length === 0) return ''
    if (list.length === 1) return t()('attentionOne', { name: list[0]?.name ?? '' })
    return t()('attentionMany', { count: list.length })
  }

  return (
    <div class="relative h-[calc(100dvh-10.5rem)] min-h-[520px] w-full overflow-hidden rounded-panel border border-line bg-subtle">
      {/* 3D canvas 是纯视觉表现，交互都在 HUD；按 PLAN-AGENT-OFFICE §6.2 设 aria-hidden。 */}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative canvas, interactions live in the HUD */}
      <canvas
        ref={(element) => {
          canvasEl = element
        }}
        class="absolute inset-0 h-full w-full"
        aria-hidden="true"
      />

      {/* 顶部状态条（3D 视图的一部分，不是 2D 列表） */}
      <Show when={mode() === 'ready'}>
        <div class="pointer-events-none absolute top-4 left-4 z-10 flex items-center gap-2">
          <span class="rounded-full border border-line bg-surface/90 px-2.5 py-1 text-badge font-semibold text-ink shadow-card">
            {t()('floorLabel')}
          </span>
          <Show when={presence.connection() !== 'live'}>
            <span class="rounded-full border border-warning bg-warning-soft px-2.5 py-1 font-mono text-badge text-warning">
              {presence.connection() === 'offline' ? t()('staleSnapshot') : t()('reconnecting')}
            </span>
          </Show>
          <Show when={presence.data() === undefined && presence.error() !== ''}>
            <span class="rounded-full border border-danger bg-danger-soft px-2.5 py-1 font-mono text-badge text-danger">
              {presence.error()}
            </span>
          </Show>
        </div>
      </Show>

      <Show when={mode() === 'probing'}>
        <div class="absolute inset-0 grid place-items-center text-meta text-ink-2">
          {t()('starting')}
        </div>
      </Show>

      <Show when={mode() === 'ready'}>
        <div class="pointer-events-none absolute inset-0">
          <DispatchCard
            primary={primary()}
            queue={queue()}
            deskCount={deskCount()}
            benchCount={benchCount()}
            unseatedCount={unseatedCount()}
            labelOf={(agent) => phaseLabel(t(), agent)}
            onSelect={selectAgent}
            t={t()}
          />

          <div class="pointer-events-auto absolute top-4 left-1/2 z-10 -translate-x-1/2">
            <div class="flex gap-1 rounded-panel border border-line bg-surface/90 p-1 shadow-card">
              <span class="self-center px-1.5 font-mono text-badge text-ink-3">
                {t()('camera')}
              </span>
              {CAMERA_LABELS.map(([preset, key]) => (
                <button
                  type="button"
                  class={cameraPreset() === preset ? cameraActive : cameraIdle}
                  aria-pressed={cameraPreset() === preset ? 'true' : 'false'}
                  onClick={() => chooseCamera(preset)}
                >
                  {t()(key)}
                </button>
              ))}
            </div>
          </div>

          <CallSheet
            agents={agents()}
            selectedId={selectedId()}
            labelOf={(agent) => phaseLabel(t(), agent)}
            attentionOf={(agent) => needsAttention(phaseOf(agent))}
            onSelect={selectAgent}
            t={t()}
          />

          <AttentionBanner
            visible={attention().length > 0 && !drawerVisible()}
            message={bannerMessage()}
            hint={t()('jumpHint')}
            onJump={jumpNext}
          />

          <Show when={presence.data() !== undefined && agents().length === 0}>
            <div class="pointer-events-auto absolute bottom-24 left-1/2 z-10 w-full max-w-md -translate-x-1/2 rounded-panel border border-dashed border-line-strong bg-surface/92 p-4 text-center shadow-card">
              <p class="text-meta text-ink-2">{t()('emptyFloor')}</p>
              <code class="mt-2 block rounded-control bg-ink px-3 py-2 font-mono text-badge text-canvas">
                {t()('emptyFloorCommand')}
              </code>
            </div>
          </Show>
        </div>
      </Show>

      {/* 抽屉：context lost 时若已打开则保留，审批仍可提交 */}
      <Show when={drawerVisible() ? selectedId() : undefined} keyed>
        {(id) => (
          <Drawer
            id={id}
            agents={agents}
            busy={deciding()}
            error={decideError()}
            locale={app.locale()}
            onClose={() => {
              setSelectedId(undefined)
              setKeepDrawer(false)
            }}
            onDecide={(approvalId, action) => void decide(approvalId, action)}
            t={t()}
          />
        )}
      </Show>

      <Show when={mode() === 'unsupported'}>
        <Unsupported
          reason={failure().reason}
          detail={failure().detail}
          renderer={failure().renderer}
          t={t()}
        />
      </Show>

      <Show when={mode() === 'ready' && presence.connection() === 'offline'}>
        <div class="absolute right-4 bottom-4 z-10">
          <Button size="sm" variant="ghost" onClick={() => presence.refresh()}>
            <Icon name="refresh" size={13} />
            {t()('retry')}
          </Button>
        </div>
      </Show>
    </div>
  )
}
