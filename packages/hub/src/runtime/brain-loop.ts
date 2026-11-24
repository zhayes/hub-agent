import { buildBrainInput } from '../brain/snapshot'
import type {
  BrainAction,
  BrainBudget,
  BrainInput,
  DecisionRecord,
  DecisionRecordType,
  OrchestratorBrain,
} from '../brain/types'
import { DEFAULT_BRAIN_BUDGET } from '../brain/types'
import { type ActionValidation, estimateInputTokens, validateBrainActions } from '../brain/validate'
import { HubError } from '../shared/errors'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { lastSeq } from '../storage/write/events'
import type { DecisionPoint } from './decision-queue'
import {
  claimDecisionPoint,
  completeDecisionPoint,
  enqueueDecisionPoint,
  pendingDecisionPoints,
} from './decision-queue'
import { recordDecision } from './decision-record'

export interface RunBrainRoundOptions {
  db: Db
  brain: OrchestratorBrain
  goalId: string
  reason: string
  dedupeKey: string
  agents: BrainInput['agents']
  budget?: BrainBudget
  planRevision?: number
  claimedBy?: string
  payload?: unknown
}

export interface BrainRoundResult {
  point: DecisionPoint
  input: BrainInput
  actions: BrainAction[]
  validation: ActionValidation
  record: DecisionRecord
}

function decisionTypeOf(actions: readonly BrainAction[]): DecisionRecordType {
  const first = actions[0]
  if (first === undefined) return 'accept_result'
  switch (first.type) {
    case 'revise_plan':
      return 'decompose'
    case 'delegate':
      return 'select_agent'
    case 'accept':
    case 'finish':
      return 'accept_result'
    case 'reject':
      return 'retry'
    case 'cancel':
      return 'abort'
    case 'request_human':
      return 'accept_result'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HubError('BUDGET_EXHAUSTED', `${label} 超时（${timeoutMs}ms）`, { timeoutMs }))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 一个 Brain 回合：入队/claim → 快照 → step → 校验 → DecisionRecord。
 * 不执行动作；执行由 Runtime 完成。
 */
export async function runBrainRound(
  options: RunBrainRoundOptions,
): Promise<BrainRoundResult | undefined> {
  const budget = options.budget ?? DEFAULT_BRAIN_BUDGET
  enqueueDecisionPoint(options.db, {
    goalId: options.goalId,
    reason: options.reason,
    dedupeKey: options.dedupeKey,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  })
  const point = claimDecisionPoint(options.db, options.goalId, options.claimedBy ?? 'brain')
  if (point === undefined) {
    // 已处理或已被其他 writer claim：本回合不再派发。
    return undefined
  }

  const state = loadState(options.db)
  const input = buildBrainInput({
    state,
    goalId: options.goalId,
    agents: options.agents,
    pending: pendingDecisionPoints(options.db, options.goalId).map((item) => ({
      id: item.id,
      reason: item.reason,
      createdAt: item.createdAt,
    })),
    budget,
    stateVersion: lastSeq(options.db),
    ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
  })

  const inputTokens = estimateInputTokens(input)
  if (inputTokens > budget.maxInputTokens) {
    const validation: ActionValidation = {
      ok: false,
      actions: [],
      errors: [
        {
          index: -1,
          message: `输入快照估算 ${inputTokens} tokens 超过上限 ${budget.maxInputTokens}`,
        },
      ],
    }
    const record = recordDecision(options.db, {
      goalId: options.goalId,
      ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
      type: 'abort',
      rationale: 'Brain 回合超出输入预算，未调用模型',
      inputs: {
        decisionPointId: point.id,
        stateVersion: input.stateVersion,
        inputTokens,
        errors: validation.errors,
      },
    })
    completeDecisionPoint(options.db, point.id, 'failed', 'BUDGET_EXHAUSTED')
    return { point, input, actions: [], validation, record }
  }

  let rawActions: BrainAction[]
  try {
    rawActions = await withTimeout(options.brain.step(input), budget.timeoutMs, 'brain.step')
  } catch (error) {
    completeDecisionPoint(
      options.db,
      point.id,
      'failed',
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }

  const currentVersion = lastSeq(options.db)
  if (currentVersion !== input.stateVersion) {
    const validation: ActionValidation = {
      ok: false,
      actions: [],
      errors: [
        {
          index: -1,
          message: `快照已过期：stateVersion ${input.stateVersion} → ${currentVersion}`,
        },
      ],
    }
    const record = recordDecision(options.db, {
      goalId: options.goalId,
      ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
      type: 'abort',
      rationale: 'Brain 回合期间状态已变化，丢弃本次动作，等待重建快照',
      inputs: {
        decisionPointId: point.id,
        expectedStateVersion: input.stateVersion,
        currentStateVersion: currentVersion,
        errors: validation.errors,
      },
    })
    completeDecisionPoint(options.db, point.id, 'failed', 'stale_state_version')
    return { point, input, actions: [], validation, record }
  }

  const validation = validateBrainActions(input, rawActions, budget)
  const outputTokens = Math.ceil(JSON.stringify(validation.actions).length / 4)
  if (outputTokens > budget.maxOutputTokens) {
    validation.ok = false
    validation.actions = []
    validation.errors.push({
      index: -1,
      message: `输出动作估算 ${outputTokens} tokens 超过上限 ${budget.maxOutputTokens}`,
    })
  }
  const rationales = await options.brain.explain(input).catch(() => [])
  const rationale =
    rationales
      .map((item) => item.rationale)
      .filter(Boolean)
      .join('；') ||
    validation.actions[0]?.type ||
    'no rationale'
  const alternatives = rationales.flatMap((item) => item.alternatives ?? [])

  const record = recordDecision(options.db, {
    goalId: options.goalId,
    ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
    type: decisionTypeOf(validation.actions),
    rationale,
    inputs: {
      decisionPointId: point.id,
      stateVersion: input.stateVersion,
      actions: validation.actions,
      errors: validation.errors,
    },
    ...(alternatives.length === 0 ? {} : { alternatives }),
  })

  completeDecisionPoint(
    options.db,
    point.id,
    validation.ok ? 'done' : 'failed',
    validation.ok ? undefined : validation.errors.map((error) => error.message).join('; '),
  )

  return { point, input, actions: validation.actions, validation, record }
}
