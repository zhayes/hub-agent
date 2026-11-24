import { createBrainFromEnv } from '../brain/create-brain'
import type { BrainBudget, DecisionRecord, OrchestratorBrain } from '../brain/types'
import type { Goal } from '../domain/entities'
import { asGoalId, asTimestamp } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { runAcpWithRetry } from './acp-retry'
import type { RunAcpTaskOptions, RunAcpTaskResult } from './acp-run'
import { runBrainRound } from './brain-loop'

/**
 * M6 的 Brain 驱动入口：
 *   建 Goal → Brain 拆计划 → Brain 选 Agent → 执行 → Brain 接收结果。
 *
 * 默认走 Pi SDK Brain（HUBAGENT_BRAIN_MODE=pi）；显式 scripted 才用测试替身。
 * LLM 输出仍由 brain-loop/validate 做 schema/权限/预算/幂等校验。
 */

export interface RunGoalWithBrainOptions extends Omit<RunAcpTaskOptions, 'goalId' | 'plan'> {
  brain?: OrchestratorBrain
  budget?: BrainBudget
}

export interface RunGoalWithBrainResult extends RunAcpTaskResult {
  decisions: DecisionRecord[]
}

export async function runGoalWithBrain(
  options: RunGoalWithBrainOptions,
): Promise<RunGoalWithBrainResult> {
  const { brain = createBrainFromEnv(), budget, ...taskOptions } = options
  const goalId = asGoalId(newId())
  const now = asTimestamp(new Date().toISOString())
  const title =
    options.objective.length > 80 ? `${options.objective.slice(0, 77)}...` : options.objective
  const goal: Goal = {
    id: goalId,
    userId: 'local',
    title,
    intent: options.objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  const state = loadState(options.db)
  appendEvent(options.db, state, { type: 'goal.created', goal })

  const agents = [
    {
      id: options.agent.id,
      name: options.agent.name,
      status: options.agent.status,
      ...(options.agent.capabilities === undefined
        ? {}
        : { capabilities: options.agent.capabilities }),
    },
  ]

  const decompose = await runBrainRound({
    db: options.db,
    brain,
    goalId,
    reason: 'plan_invalid',
    dedupeKey: `goal:${goalId}:decompose`,
    agents,
    ...(budget === undefined ? {} : { budget }),
  })
  if (decompose === undefined) {
    throw new HubError('ACTION_REJECTED', '初始计划决策点已被处理', { goalId })
  }
  const revise = decompose.actions.find((action) => action.type === 'revise_plan')
  if (revise === undefined || revise.type !== 'revise_plan') {
    throw new HubError('ACTION_REJECTED', 'Brain 未产出 revise_plan', {
      goalId,
      actions: decompose.actions,
    })
  }
  const draft = revise.subtasks[0]
  if (draft === undefined) {
    throw new HubError('ACTION_REJECTED', 'Brain 的 revise_plan 为空', { goalId })
  }

  const result = await runAcpWithRetry({
    ...taskOptions,
    goalId,
    plan: {
      taskTitle: draft.title,
      taskDescription: draft.description,
      subtaskTitle: draft.title,
      subtaskDescription: draft.description,
    },
  })

  const after = await runBrainRound({
    db: options.db,
    brain,
    goalId,
    reason: 'subtask_terminal',
    dedupeKey: `goal:${goalId}:after-run`,
    agents,
    ...(budget === undefined ? {} : { budget }),
  })

  return {
    ...result,
    decisions: [decompose.record, ...(after === undefined ? [] : [after.record])],
  }
}
