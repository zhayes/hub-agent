import { ScriptedBrain } from '../brain/scripted-brain'
import type { BrainBudget, DecisionRecord, OrchestratorBrain } from '../brain/types'
import type { Goal } from '../domain/entities'
import { asGoalId, asTimestamp } from '../domain/ids'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { type RunAcpTaskOptions, type RunAcpTaskResult, runAcpTask } from './acp-run'
import { runBrainRound } from './brain-loop'

/**
 * M6 的 Brain 驱动入口：
 *   建 Goal → Brain 拆计划 → Brain 选 Agent → 执行 → Brain 接收结果。
 *
 * M6 用 ScriptedBrain 证明“快照 → 动作 → DecisionRecord”可重放；
 * Pi/LLM 实现替换 OrchestratorBrain 即可，不需要改 Runtime。
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
  const { brain = new ScriptedBrain(), budget, ...taskOptions } = options
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

  const result = await runAcpTask({
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
