import type { ChatRunSettings } from '../../domain/chat'
import type { VerificationCheck } from '../../domain/entities'
import type { AgentRecord } from '../agent-registry'

/**
 * 会话级运行设置 → 运行时参数（ADR 0029 §2.4）。
 *
 * 这里是 domain 的结构化类型与 runtime 具体类型相接的那一层。
 * 没有预算映射：成本/用量没有计量源，就不做预算（ADR 0031）。
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
