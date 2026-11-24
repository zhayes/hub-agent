import type { BrainAction } from '../brain/types'
import { HubError } from '../shared/errors'
import { type RunAcpTaskOptions, type RunAcpTaskResult, runAcpTask } from './acp-run'
import { recordDecision } from './decision-record'
import { failGoal, failTask } from './recovery/fail'
import { decideEscalation } from './recovery/failure'

export interface RunAcpWithRetryOptions
  extends Omit<
    RunAcpTaskOptions,
    | 'goalId'
    | 'taskId'
    | 'subtaskId'
    | 'executionId'
    | 'idempotencyKey'
    | 'retryOnFailure'
    | 'attempt'
  > {
  goalId: string
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
  let taskId: string | undefined
  let subtaskId: string | undefined
  let protocolRetries = 0

  for (;;) {
    try {
      const result = await runAcpTask({
        ...options,
        taskId,
        subtaskId,
        attempt,
        retryOnFailure: true,
        ...(taskId === undefined ? {} : { taskId }),
        ...(subtaskId === undefined ? {} : { subtaskId }),
      })
      taskId = result.taskId
      subtaskId = result.subtaskId
      if (result.ok) return result
      if (result.approval !== undefined || result.verdict === 'manual_required') return result

      const changedFiles = result.evidence.changedFiles ?? []
      const decision = decideEscalation({
        class: 'execution',
        hasSideEffects: changedFiles.length > 0,
        sameAgentFailures: attempt,
        agentSwitches: 0,
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
