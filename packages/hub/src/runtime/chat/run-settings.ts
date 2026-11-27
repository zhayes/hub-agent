import type { BrainBudget } from '../../brain/types'
import { DEFAULT_BRAIN_BUDGET } from '../../brain/types'
import type { ChatRunSettings } from '../../domain/chat'
import type { VerificationCheck } from '../../domain/entities'
import type { AgentRecord } from '../agent-registry'

/**
 * 会话级运行设置 → 运行时参数（ADR 0029 §2.4）。
 *
 * 这里是 domain 的结构化类型与 runtime 具体类型相接的那一层：
 * `domain/chat` 不能 import 其他层，所以两边用 `satisfies` 对齐，
 * 任何一侧改了字段，编译期就会在这里报错，而不是运行时静默丢掉预算。
 */

/** CLI 的验收命令用 10 分钟，控制台保持一致。 */
const VERIFY_TIMEOUT_MS = 10 * 60_000

/**
 * 验收入口：用户给的命令（退出码 0 为通过）+ 默认的 diffScope。
 *
 * 没给命令时只剩 diffScope——它只能证明「改动没越界」，不能证明「任务做成了」。
 * 这是控制台今天比 CLI 弱的一处，UI 在设置面板里直说了，不在这里假装。
 */
export function verificationChecks(settings: ChatRunSettings): VerificationCheck[] {
  return [
    ...settings.verifyCommands.map(
      (cmd): VerificationCheck => ({
        kind: 'command',
        cmd,
        timeoutMs: VERIFY_TIMEOUT_MS,
        expect: { exitCode: 0 },
      }),
    ),
    { kind: 'diffScope', allowedPaths: ['.'] },
  ]
}

/** 预算：界面上只给「回合超时」与「最多动作」，token 上限用运行时默认值补齐。 */
export function brainBudget(settings: ChatRunSettings): BrainBudget | undefined {
  const budget = settings.budget
  if (budget === null) return undefined
  return {
    maxActions: budget.maxActions ?? DEFAULT_BRAIN_BUDGET.maxActions,
    maxInputTokens: DEFAULT_BRAIN_BUDGET.maxInputTokens,
    maxOutputTokens: DEFAULT_BRAIN_BUDGET.maxOutputTokens,
    timeoutMs: budget.timeoutMs ?? DEFAULT_BRAIN_BUDGET.timeoutMs,
  }
}

/**
 * 扇出范围：设置里选了哪些 Agent，Brain 就只在这些 Agent 里派单。
 * 空 = 不限制（全部已注册 Agent）。
 */
export function scopeAgents(
  agents: readonly AgentRecord[],
  settings: ChatRunSettings,
): AgentRecord[] {
  if (settings.agents.length === 0) return [...agents]
  const allowed = new Set(settings.agents)
  return agents.filter((agent) => allowed.has(agent.name))
}
