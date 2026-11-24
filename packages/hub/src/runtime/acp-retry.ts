import type { BrainAction } from '../brain/types'
import { HubError } from '../shared/errors'
import { type RunAcpTaskOptions, type RunAcpTaskResult, runAcpTask } from './acp-run'
import type { AgentRecord } from './agent-registry'
import { recordDecision } from './decision-record'
import { failGoal, failTask } from './recovery/fail'
import { decideEscalation } from './recovery/failure'
import { selectAgent } from './selection/select'

export interface RunAcpWithRetryOptions
  extends Omit<RunAcpTaskOptions, 'goalId' | 'idempotencyKey' | 'retryOnFailure' | 'attempt'> {
  goalId: string
  availableAgents?: readonly AgentRecord[]
  /** 首次 attempt 可复用 worktree session 的 executionId；重试时清空 */
  executionId?: string
}

const PROTOCOL_RETRY_LIMIT = 2

/**
 * M8 自动重试循环：
 *   - 协议/启动失败（还没有 Task 记录）：Runtime 重试最多 2 次；
 *   - 执行失败：无 diff 时同 Agent 重试 1 次；有 diff/审批/人工输入不静默重试；
 *   - 重试耗尽才 failTask；每次升级写 DecisionRecord。
 *
 * 不做换 Agent/重规划（需要 Selection Engine/Brain），到该阈值时收敛失败并记录原因。
 */
export async function runAcpWithRetry(options: RunAcpWithRetryOptions): Promise<RunAcpTaskResult> {
  let attempt = 1
  let taskId: string | undefined = options.taskId
  let subtaskId: string | undefined = options.subtaskId
  let protocolRetries = 0
  let currentAgent = options.agent
  let executionId: string | undefined = options.executionId
  let agentSwitches = 0
  const triedAgents = new Set<string>()

  for (;;) {
    try {
      const result = await runAcpTask({
        ...options,
        agent: currentAgent,
        taskId,
        subtaskId,
        executionId,
        attempt,
        retryOnFailure: true,
        ...(taskId === undefined ? {} : { taskId }),
        ...(subtaskId === undefined ? {} : { subtaskId }),
      })
      taskId = result.taskId
      subtaskId = result.subtaskId
      executionId = undefined
      if (result.ok) return result
      if (result.approval !== undefined || result.verdict === 'manual_required') return result

      const changedFiles = result.evidence.changedFiles ?? []
      const decision = decideEscalation({
        class: 'execution',
        hasSideEffects: changedFiles.length > 0,
        sameAgentFailures: attempt,
        agentSwitches,
        replans: 0,
        protocolRetries: 0,
      })
      recordDecision(options.db, {
        goalId: options.goalId,
        type: decision.action === 'same_agent_retry' ? 'retry' : 'abort',
        rationale: decision.reason,
        inputs: {
          attempt,
          executionId: result.executionId,
          verdict: result.verdict,
          changedFiles,
          action: decision.action,
        },
      })

      if (decision.action === 'same_agent_retry') {
        attempt += 1
        await delay(500 * attempt)
        continue
      }
      if (decision.action === 'switch_agent') {
        triedAgents.add(currentAgent.id)
        let next: AgentRecord
        try {
          next = selectAgent(options.db, {
            agents: options.availableAgents ?? [options.agent],
            excludeAgentIds: [...triedAgents],
          })
        } catch (error) {
          failTask(options.db, {
            taskId: result.taskId,
            goalId: result.goalId,
            subtaskId: result.subtaskId,
            failGoal: false,
          })
          recordDecision(options.db, {
            goalId: options.goalId,
            type: 'replan',
            rationale: '没有可切换的 Agent，交给 Brain 重新规划',
            inputs: { attempt, error: error instanceof Error ? error.message : String(error) },
          })
          return { ...result, replanRequired: true }
        }
        currentAgent = next
        agentSwitches += 1
        attempt += 1
        recordDecision(options.db, {
          goalId: options.goalId,
          type: 'select_agent',
          rationale: `同一 Subtask 连续失败，切换到 Agent ${next.name}`,
          inputs: { from: [...triedAgents], to: next.id, attempt },
        })
        await delay(300)
        continue
      }

      failTask(options.db, {
        taskId: result.taskId,
        goalId: result.goalId,
        subtaskId: result.subtaskId,
      })
      return result
    } catch (error) {
      // 已建 Task 的后半程异常：有副作用风险，不自动重试；收敛失败。
      const details =
        error instanceof HubError && typeof error.details === 'object' && error.details !== null
          ? (error.details as Record<string, unknown>)
          : {}
      if (typeof details.taskId === 'string' && typeof details.goalId === 'string') {
        failTask(options.db, {
          taskId: details.taskId,
          goalId: details.goalId,
          ...(typeof details.subtaskId === 'string' ? { subtaskId: details.subtaskId } : {}),
        })
        recordDecision(options.db, {
          goalId: options.goalId,
          type: 'abort',
          rationale: '执行异常且已有任务记录，不自动重试，避免重复副作用',
          inputs: { details },
        })
        throw error
      }
      if (protocolRetries < PROTOCOL_RETRY_LIMIT) {
        protocolRetries += 1
        recordDecision(options.db, {
          goalId: options.goalId,
          type: 'retry',
          rationale: `协议/启动失败，Runtime 重试第 ${protocolRetries} 次`,
          inputs: {
            protocolRetries,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        await delay(500 * protocolRetries)
        continue
      }
      if (taskId === undefined) failGoal(options.db, options.goalId)
      throw error
    }
  }
}

/** 供未来 Brain 动作集成；当前只记录，不执行。 */
export type RetryAction = Extract<BrainAction, { type: 'reject' }>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
