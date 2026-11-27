import { createEffect, createSignal, For, Show } from 'solid-js'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { fieldControl } from '../../components/ui/Field'
import { Icon } from '../../components/ui/Icon'
import type { AgentRow, ChatRunSettings } from '../../shared/api'
import { DEFAULT_RUN_SETTINGS } from '../../shared/api'
import type { Translator } from '../../shared/i18n'

/**
 * 会话级运行设置（ADR 0029 §2.4）。
 *
 * 接管 CLI 的三个「只有命令行才能设」的旋钮：验收命令、可用 Agent（扇出范围）、
 * 预算。它们都只影响**之后的回合**，所以面板里直说，不假装能改已经跑起来的那次。
 *
 * 不在这里放交付方式：交付是任务页上的一次显式动作（PRD §6.12.4 第一优先级
 * 就是「用户单次显式指定」），不是会话默认值。
 */
export interface RunSettingsDialogProps {
  open: boolean
  onClose: () => void
  settings: ChatRunSettings
  agents: readonly AgentRow[]
  t: Translator
  onSave: (settings: ChatRunSettings) => void
}

const section = 'flex flex-col gap-1.5'
const sectionLabel = 'text-meta font-medium text-ink-2'
const hint = 'text-badge text-ink-3'
const row = 'flex items-center gap-2'

const minutesOf = (timeoutMs: number | undefined): string =>
  timeoutMs === undefined ? '' : String(Math.round(timeoutMs / 60_000))

export function RunSettingsDialog(props: RunSettingsDialogProps) {
  const [commands, setCommands] = createSignal<string[]>([])
  const [agents, setAgents] = createSignal<string[]>([])
  const [minutes, setMinutes] = createSignal('')
  const [actions, setActions] = createSignal('')

  /* 每次打开都从当前设置重建草稿：关掉再打开不该留着上一次没保存的改动。 */
  createEffect(
    () => props.open,
    (open) => {
      if (open !== true) return
      const settings = props.settings
      setCommands([...settings.verifyCommands])
      setAgents([...settings.agents])
      setMinutes(minutesOf(settings.budget?.timeoutMs))
      setActions(
        settings.budget?.maxActions === undefined ? '' : String(settings.budget.maxActions),
      )
    },
  )

  const toggleAgent = (name: string): void => {
    setAgents((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    )
  }

  const save = (): void => {
    const timeout = Number.parseInt(minutes(), 10)
    const maxActions = Number.parseInt(actions(), 10)
    const budget =
      (Number.isFinite(timeout) && timeout > 0) || (Number.isFinite(maxActions) && maxActions > 0)
        ? {
            ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout * 60_000 } : {}),
            ...(Number.isFinite(maxActions) && maxActions > 0 ? { maxActions } : {}),
          }
        : null
    props.onSave({
      verifyCommands: commands()
        .map((command) => command.trim())
        .filter((command) => command !== ''),
      agents: agents(),
      budget,
    })
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.t('runSettings')}
      closeLabel={props.t('close')}
    >
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 py-4">
        <p class={hint}>{props.t('runSettingsHint')}</p>

        {/* 可用 Agent = 扇出范围：Brain 只会在勾选的 Agent 里派单。 */}
        <div class={section}>
          <span class={sectionLabel}>{props.t('runSettingsAgents')}</span>
          <Show when={props.agents.length > 0} fallback={<p class={hint}>{props.t('noAgents')}</p>}>
            <div class="flex flex-wrap gap-1.5">
              <For each={props.agents}>
                {(agent) => (
                  <label
                    class={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-badge transition-colors ${
                      agents().includes(agent.name)
                        ? 'border-line-strong bg-raised font-medium text-ink'
                        : 'border-line text-ink-3 hover:text-ink'
                    }`}
                  >
                    <input
                      type="checkbox"
                      class="size-3 accent-[var(--hx-accent)]"
                      checked={agents().includes(agent.name)}
                      onChange={() => toggleAgent(agent.name)}
                    />
                    {agent.name}
                  </label>
                )}
              </For>
            </div>
            <p class={hint}>{props.t('runSettingsAgentsHint')}</p>
          </Show>
        </div>

        {/* 验收命令：退出码 0 为通过。空的时候只有一个 diffScope，说明白。 */}
        <div class={section}>
          <span class={sectionLabel}>{props.t('runSettingsVerify')}</span>
          <For each={commands()}>
            {(command, index) => (
              <div class={row}>
                <input
                  class={`${fieldControl} min-w-0 flex-1 font-mono text-badge`}
                  value={command}
                  aria-label={props.t('runSettingsVerify')}
                  placeholder="pnpm test:unit"
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setCommands((current) =>
                      current.map((item, at) => (at === index() ? value : item)),
                    )
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={props.t('runSettingsRemoveCommand')}
                  onClick={() =>
                    setCommands((current) => current.filter((_, at) => at !== index()))
                  }
                >
                  <Icon name="x" size={13} />
                </Button>
              </div>
            )}
          </For>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCommands((current) => [...current, ''])}
            >
              {props.t('runSettingsAddCommand')}
            </Button>
          </div>
          <p class={hint}>{props.t('runSettingsVerifyHint')}</p>
        </div>

        {/* 预算：只给两个能说清的旋钮，token 上限由运行时默认值补齐。 */}
        <div class={section}>
          <span class={sectionLabel}>{props.t('runSettingsBudget')}</span>
          <div class="flex flex-wrap items-start gap-3">
            <label class="flex flex-col gap-1">
              <span class={hint}>{props.t('runSettingsTimeout')}</span>
              <input
                class={`${fieldControl} w-28 shrink-0 tabular-nums`}
                type="number"
                min="1"
                inputmode="numeric"
                value={minutes()}
                placeholder={props.t('runSettingsDefault')}
                onChange={(event) => setMinutes(event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class={hint}>{props.t('runSettingsActions')}</span>
              <input
                class={`${fieldControl} w-28 shrink-0 tabular-nums`}
                type="number"
                min="1"
                inputmode="numeric"
                value={actions()}
                placeholder={props.t('runSettingsDefault')}
                onChange={(event) => setActions(event.currentTarget.value)}
              />
            </label>
          </div>
          <p class={hint}>{props.t('runSettingsBudgetHint')}</p>
        </div>

        <p class="rounded-control border border-line bg-subtle px-2.5 py-2 text-badge text-ink-2">
          {props.t('runSettingsBackground')}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button onClick={save}>{props.t('save')}</Button>
        <Button variant="ghost" onClick={props.onClose}>
          {props.t('cancel')}
        </Button>
        <span class="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setCommands([...DEFAULT_RUN_SETTINGS.verifyCommands])
            setAgents([...DEFAULT_RUN_SETTINGS.agents])
            setMinutes('')
            setActions('')
          }}
        >
          {props.t('runSettingsReset')}
        </Button>
      </div>
    </Dialog>
  )
}
