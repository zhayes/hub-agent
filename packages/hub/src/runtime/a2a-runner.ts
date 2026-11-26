import { createBrainFromEnv } from '../brain/create-brain'
import type { BrainBudget, OrchestratorBrain } from '../brain/types'
import type { VerificationCheck } from '../domain/entities'
import type { SandboxProvider } from '../sandbox/types'
import type { Db } from '../storage/db'
import type { InboundTaskRunner } from './a2a-executor'
import { type AgentRecord, resolveAgent } from './agent-registry'
import { runGoalWithBrain } from './brain-run'
import { cancelTask } from './recovery/cancel'

export interface InboundRunnerDeps {
  db: Db
  provider: SandboxProvider
  /** 缺省在 run 时按 `createBrainFromEnv()` 创建（失败则任务 FAILED，不拖垮 daemon）。 */
  brain?: OrchestratorBrain
  /** 缺省在 run 时用 `resolveAgent(db)`；都没有则任务 FAILED。 */
  agent?: AgentRecord
  worktree: string
  checks?: readonly VerificationCheck[]
  budget?: BrainBudget
}

/**
 * 把 A2A 入站任务接到本地 Runtime。
 *
 * 关键取舍：远端只看到 A2A `Task`；本地 Goal/Task/Execution 仍然是内部实现
 * （PRD §7.4 的边界）。所以这里**不**把 A2A taskId 当本地 taskId 用，
 * 只在内存里维护 `A2A taskId → 本地 taskId` 供取消使用。
 */
export function createInboundTaskRunner(deps: InboundRunnerDeps): InboundTaskRunner {
  const active = new Map<string, { contextId: string; localTaskId?: string }>()

  return {
    async run({ taskId, contextId, objective }) {
      const entry: { contextId: string; localTaskId?: string } = { contextId }
      active.set(taskId, entry)
      try {
        const agent = deps.agent ?? resolveAgent(deps.db)
        const brain = deps.brain ?? createBrainFromEnv()
        const result = await runGoalWithBrain({
          db: deps.db,
          provider: deps.provider,
          brain,
          agent,
          objective,
          worktree: deps.worktree,
          ...(deps.checks === undefined ? {} : { checks: deps.checks }),
          ...(deps.budget === undefined ? {} : { budget: deps.budget }),
          onTaskCreated: ({ taskId: localTaskId }) => {
            entry.localTaskId = localTaskId
          },
        })

        return result.ok
          ? {
              state: 'completed' as const,
              ...(result.reply === undefined ? {} : { summary: result.reply }),
            }
          : { state: 'failed' as const, error: result.stopReason }
      } finally {
        active.delete(taskId)
      }
    },

    async cancel(taskId) {
      const entry = active.get(taskId)
      if (entry?.localTaskId !== undefined) {
        cancelTask(deps.db, entry.localTaskId)
      }
      return { contextId: entry?.contextId ?? '' }
    },
  }
}
