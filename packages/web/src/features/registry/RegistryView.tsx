import { createSignal, For, onSettled, Show } from 'solid-js'
import { useApp } from '../../app/store'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Icon } from '../../components/ui/Icon'
import {
  type AgentRow,
  api,
  type CatalogScan,
  type ProbeResultView,
  type ScannedAgent,
  type ScanVariant,
} from '../../shared/api'
import { formatRelativeTime, type MessageKey } from '../../shared/i18n'

/**
 * 接入分段（`/registry`）：扫描本机、按目录接入、验证连接。
 *
 * 只做三件事，没有自由填命令的入口：目录之外的 harness 走 CLI（ADR 0021）。
 * 行规格与任务列表一致（§3.8.5）：无分隔线、状态点 + 11px 次行、hover 抬起。
 */

type Action = 'adopt' | 'verify' | 'login' | 'remove' | 'disable' | 'enable'

const page = 'flex min-h-0 flex-1 flex-col overflow-y-auto'
const column = 'mx-auto w-full max-w-[720px] px-5 pt-3 pb-10 max-[860px]:px-4 max-[860px]:pt-2'
const toolbar = 'flex flex-wrap items-center justify-between gap-3 px-2 pb-2'
const toolbarMeta = 'flex flex-wrap items-center gap-2 text-badge text-ink-3'
const list = 'flex flex-col gap-px'
const row =
  'flex items-center gap-3 rounded-control px-2 py-2 transition-colors hover:bg-raised max-[700px]:flex-wrap'
const rowMain = 'min-w-0 flex-1'
const name = 'truncate text-meta font-medium text-ink'
const source = 'mt-0.5 block truncate font-mono text-badge text-ink-3'
const rowActions = 'flex shrink-0 items-center gap-1.5 max-[700px]:w-full max-[700px]:justify-end'
const empty = 'rounded-panel border border-dashed border-line-strong px-4 py-4 text-meta text-ink-2'
const hint = 'mt-1 text-badge text-ink-3'
const dialogBody = 'flex flex-col gap-4 px-4 py-4'
const fieldLabel = 'text-badge font-semibold tracking-wide text-ink-3 uppercase'
const monoBlock =
  'm-0 max-h-40 overflow-auto rounded-control border border-line bg-subtle px-3 py-2 font-mono text-meta break-all text-ink-2'
const detailActions = 'flex flex-wrap items-center gap-2 border-t border-line px-4 py-3'

/* 状态只用一个点 + 一个词：彩色胶囊会把一列 Agent 变成灯泡墙（§3.8.1）。 */
const STATUS_DOT: Record<string, string> = {
  online: 'bg-success',
  needs_auth: 'bg-accent',
  error: 'bg-danger',
  missing: 'bg-danger',
  disabled: 'bg-ink-3',
}

const statusDot = (status: string): string => STATUS_DOT[status] ?? 'bg-ink-3'

function statusOf(entry: ScannedAgent, agents: AgentRow[]): string {
  if (!entry.registered) return 'discovered'
  const agent = agents.find((item) => item.name === entry.name)
  return agent?.status ?? entry.agentStatus ?? 'discovered'
}

function statusLabel(key: string): MessageKey {
  if (key === 'online') return 'statusOnline'
  if (key === 'needs_auth') return 'statusNeedsAuth'
  if (key === 'error') return 'statusAgentError'
  if (key === 'missing') return 'statusMissing'
  if (key === 'disabled') return 'statusDisabled'
  return 'statusDiscovered'
}

export function RegistryView() {
  const app = useApp()
  const [scan, setScan] = createSignal<CatalogScan>()
  const [scanning, setScanning] = createSignal(false)
  const [error, setError] = createSignal('')
  const [notice, setNotice] = createSignal('')
  const [busy, setBusy] = createSignal('')
  const [detail, setDetail] = createSignal<ScannedAgent>()
  const [probe, setProbe] = createSignal<{ name: string; result: ProbeResultView }>()

  const runScan = async (): Promise<void> => {
    setScanning(true)
    setError('')
    try {
      const result = await api.scanAgents()
      setScan(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setScanning(false)
    }
  }

  onSettled(() => {
    void runScan()
  })

  const variantOf = (entry: ScannedAgent): ScanVariant | undefined =>
    entry.variants.find((item) => item.id === entry.chosenVariant) ?? entry.variants[0]

  const isBusy = (entry: ScannedAgent, action: Action): boolean =>
    busy() === `${entry.catalogId}:${action}`

  const adopt = async (entry: ScannedAgent): Promise<void> => {
    setBusy(`${entry.catalogId}:adopt`)
    setError('')
    setNotice('')
    try {
      const result = await api.adoptAgent(entry.catalogId, entry.chosenVariant)
      setProbe({ name: entry.name, result: result.probe })
      setNotice(
        result.probe.status === 'online'
          ? app.t('registryAdoptedOnline', { name: entry.name })
          : result.probe.status === 'needs_auth'
            ? app.t('registryAdoptedAuth', { name: entry.name })
            : app.t('registryAdoptedError', { name: entry.name }),
      )
      await runScan()
      await app.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const verify = async (entry: ScannedAgent): Promise<void> => {
    setBusy(`${entry.catalogId}:verify`)
    setError('')
    try {
      const result = await api.verifyAgent(entry.name)
      setProbe({ name: entry.name, result: result.probe })
      setNotice(
        result.probe.status === 'online'
          ? app.t('registryAdoptedOnline', { name: entry.name })
          : app.t('registryAdoptedError', { name: entry.name }),
      )
      await runScan()
      await app.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const login = async (entry: ScannedAgent, methodId: string): Promise<void> => {
    setBusy(`${entry.catalogId}:login`)
    setError('')
    try {
      const result = await api.loginAgent(entry.name, methodId)
      if (!result.ok) {
        setError(result.result.error?.message ?? app.t('registryError'))
        return
      }
      setNotice(app.t('registryLoginDone'))
      await verify(entry)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const remove = async (entry: ScannedAgent): Promise<void> => {
    if (!window.confirm(app.t('registryConfirmRemove', { name: entry.name }))) return
    setBusy(`${entry.catalogId}:remove`)
    try {
      await api.removeAgent(entry.name)
      setDetail(undefined)
      await runScan()
      await app.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const toggleDisabled = async (entry: ScannedAgent, disable: boolean): Promise<void> => {
    setBusy(`${entry.catalogId}:${disable ? 'disable' : 'enable'}`)
    try {
      await api.setAgentStatus(entry.name, disable ? 'disabled' : 'discovered')
      await runScan()
      await app.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  const scannedAt = (): string => {
    const value = scan()?.scannedAt
    return value === undefined
      ? app.t('registryNeverScanned')
      : app.t('registryScannedAt', { time: formatRelativeTime(app.locale(), value) })
  }

  const agent = (entry: ScannedAgent): AgentRow | undefined =>
    app.agents().find((item) => item.name === entry.name)

  const detailProbe = (): ProbeResultView | undefined =>
    probe()?.name === detail()?.name ? probe()?.result : undefined

  return (
    <section class={page} aria-label={app.t('registry')}>
      <div class={column}>
        <div class={toolbar}>
          <div class={toolbarMeta}>
            <span>{scannedAt()}</span>
            <Show when={scan() !== undefined}>
              <span aria-hidden="true">·</span>
              <span>{app.t('registryCatalogVersion', { version: scan()?.version ?? 0 })}</span>
            </Show>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={scanning()}
            onClick={() => void runScan()}
          >
            <Icon name="refresh" size={14} />
            {scanning() ? app.t('registryScanning') : app.t('registryScan')}
          </Button>
        </div>

        <Show when={error() !== ''}>
          <p class="mb-3 rounded-panel bg-danger-soft px-3 py-2 text-meta text-danger" role="alert">
            {app.t('registryError')}: {error()}
          </p>
        </Show>
        <Show when={notice() !== ''}>
          <p
            class="mb-3 rounded-panel bg-success-soft px-3 py-2 text-meta text-success"
            role="status"
          >
            {notice()}
          </p>
        </Show>

        <Show
          when={(scan()?.agents.length ?? 0) > 0}
          fallback={
            <div class={empty}>
              <p>{scanning() ? app.t('registryScanning') : app.t('registryEmpty')}</p>
              <p class={hint}>{app.t('registryEmptyHint')}</p>
              <p class={`${hint} mt-2.5`}>{app.t('registryCliHint')}</p>
              <code class="mt-1 block overflow-x-auto rounded-control border border-line bg-subtle px-2.5 py-1.5 font-mono text-badge text-ink">
                {app.t('registryCliAdd')}
              </code>
            </div>
          }
        >
          <div class={list}>
            <For each={scan()?.agents ?? []}>
              {(entry) => {
                const status = (): string => statusOf(entry, app.agents())
                const variant = (): ScanVariant | undefined => variantOf(entry)
                return (
                  <div class={row}>
                    <div class={rowMain}>
                      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span class={name}>{entry.label}</span>
                        <span class="flex items-center gap-1.5 text-badge text-ink-3">
                          <span
                            class={`size-[7px] shrink-0 rounded-full ${statusDot(status())}`}
                            aria-hidden="true"
                          />
                          {app.t(statusLabel(status()))}
                        </span>
                        <Show when={!variant()?.adoptable}>
                          <span class="text-badge text-ink-3">
                            · {app.t('registryNotAdoptable')}
                          </span>
                        </Show>
                      </div>
                      <p class={source} title={variant()?.source}>
                        {variant()?.source ?? entry.name}
                      </p>
                      <Show when={variant()?.missingRequires.length}>
                        <p class="mt-0.5 text-badge text-warning">
                          {app.t('registryMissingRequires', {
                            items: (variant()?.missingRequires ?? []).join(' · '),
                          })}
                        </p>
                      </Show>
                    </div>
                    <div class={rowActions}>
                      <Show
                        when={entry.registered}
                        fallback={
                          <Show when={variant()?.adoptable}>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy() !== ''}
                              onClick={() => void adopt(entry)}
                            >
                              {isBusy(entry, 'adopt')
                                ? app.t('registryAdopting')
                                : app.t('registryAdopt')}
                            </Button>
                          </Show>
                        }
                      >
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy() !== ''}
                          onClick={() => void verify(entry)}
                        >
                          {isBusy(entry, 'verify')
                            ? app.t('registryVerifying')
                            : app.t('registryVerify')}
                        </Button>
                      </Show>
                      <Button variant="ghost" size="sm" onClick={() => setDetail(entry)}>
                        {app.t('registryDetail')}
                      </Button>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={(scan()?.problems.length ?? 0) > 0}>
          <div class="mt-4 text-meta text-ink-3">
            <p class={fieldLabel}>{app.t('registryProblems')}</p>
            <For each={scan()?.problems ?? []}>
              {(problem) => (
                <p class="mt-1">
                  {problem.entryId}: {problem.message}
                </p>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Dialog
        open={detail() !== undefined}
        onClose={() => setDetail(undefined)}
        title={app.t('registryDetail')}
        closeLabel={app.t('close')}
      >
        <Show when={detail()}>
          {(entry) => (
            <>
              <div class={dialogBody}>
                <div>
                  <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="truncate text-section font-semibold text-ink">
                      {entry().label}
                    </span>
                    <span class="flex items-center gap-1.5 text-badge text-ink-3">
                      <span
                        class={`size-[7px] shrink-0 rounded-full ${statusDot(statusOf(entry(), app.agents()))}`}
                        aria-hidden="true"
                      />
                      {app.t(statusLabel(statusOf(entry(), app.agents())))}
                    </span>
                  </div>
                  <Show when={entry().notes}>
                    <p class={hint}>{entry().notes}</p>
                  </Show>
                </div>

                <div>
                  <p class={fieldLabel}>{app.t('registryCommand')}</p>
                  <pre class={monoBlock}>{variantOf(entry())?.command ?? '-'}</pre>
                </div>

                <div>
                  <p class={fieldLabel}>{app.t('registrySource')}</p>
                  <p class="font-mono text-meta break-all text-ink-2">
                    {variantOf(entry())?.source ?? '-'}
                  </p>
                </div>

                <Show when={(variantOf(entry())?.allowedWrite.length ?? 0) > 0}>
                  <div>
                    <p class={fieldLabel}>{app.t('registryAllowedWrite')}</p>
                    <p class="font-mono text-meta break-all text-ink-2">
                      {(variantOf(entry())?.allowedWrite ?? []).join('\n')}
                    </p>
                  </div>
                </Show>

                <Show when={detailProbe()}>
                  {(result) => (
                    <div>
                      <p class={fieldLabel}>{app.t('registryLastProbe')}</p>
                      <p class="text-meta text-ink-2">
                        {result().status} · {result().durationMs}ms
                      </p>
                      <Show when={result().error}>
                        <p class="mt-1 text-meta text-danger">{result().error?.message}</p>
                      </Show>
                      <Show when={(result().stderrTail.length ?? 0) > 0}>
                        <details class="mt-2">
                          <summary class="cursor-pointer text-meta text-ink-3">stderr</summary>
                          <pre class={monoBlock}>{result().stderrTail.join('\n')}</pre>
                        </details>
                      </Show>
                    </div>
                  )}
                </Show>

                <Show when={agent(entry())?.lastProbeAt}>
                  <p class="text-meta text-ink-3">
                    {app.t('registryLastProbe')}:{' '}
                    {formatRelativeTime(app.locale(), agent(entry())?.lastProbeAt ?? '')}
                  </p>
                </Show>

                <Show when={detailProbe()?.status === 'needs_auth'}>
                  <div>
                    <p class={fieldLabel}>{app.t('registryLogin')}</p>
                    <div class="mt-1.5 flex flex-wrap gap-2">
                      <For each={detailProbe()?.authMethods ?? []}>
                        {(method) => (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy() !== '' || method.type === 'terminal'}
                            title={
                              method.type === 'terminal'
                                ? 'terminal auth is not supported'
                                : (method.description ?? '')
                            }
                            onClick={() => void login(entry(), method.id)}
                          >
                            {isBusy(entry(), 'login')
                              ? app.t('registryLoggingIn')
                              : (method.name ?? method.id)}
                          </Button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>

              <div class={detailActions}>
                <Show
                  when={entry().registered}
                  fallback={
                    <Show when={variantOf(entry())?.adoptable}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy() !== ''}
                        onClick={() => void adopt(entry())}
                      >
                        {app.t('registryAdopt')}
                      </Button>
                    </Show>
                  }
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy() !== ''}
                    onClick={() => void verify(entry())}
                  >
                    {app.t('registryVerify')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy() !== ''}
                    onClick={() =>
                      void toggleDisabled(entry(), statusOf(entry(), app.agents()) !== 'disabled')
                    }
                  >
                    {statusOf(entry(), app.agents()) === 'disabled'
                      ? app.t('registryEnable')
                      : app.t('registryDisable')}
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy() !== ''}
                    onClick={() => void remove(entry())}
                  >
                    {app.t('registryRemove')}
                  </Button>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Dialog>
    </section>
  )
}
