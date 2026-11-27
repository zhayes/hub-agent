import { buildBrainInput } from '../brain/snapshot'
import type {
  BrainAction,
  BrainBudget,
  BrainDeltaSink,
  BrainInput,
  ChatTurn,
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
  renewDecisionClaim,
} from './decision-queue'
import { recordDecision } from './decision-record'

export interface RunBrainRoundOptions {
  db: Db
  brain: OrchestratorBrain
  goalId: string
  reason: string
  dedupeKey: string
  agents: BrainInput['agents']
  /** 可委托的远程对端（A3）；不给则 Brain 快照里没有 peers。 */
  peers?: BrainInput['peers']
  budget?: BrainBudget
  planRevision?: number
  conversation?: readonly ChatTurn[]
  /** 传入后 Brain 会流式产生 text/thinking 增量（仅对话回合需要）。 */
  onDelta?: BrainDeltaSink
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
    case 'reply':
      return 'accept_result'
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
  const claimToken = point.claimToken
  if (claimToken === undefined) {
    throw new HubError('DB_UNAVAILABLE', '决策点 claim 缺少 claimToken', {
      decisionPointId: point.id,
    })
  }
  /** 收尾并校验持有权；false 表示这次 claim 已失效（被回收或被接管）。 */
  const finish = (status: 'done' | 'failed', error?: string): boolean =>
    completeDecisionPoint(options.db, point.id, status, {
      claimToken,
      ...(error === undefined ? {} : { error }),
    })

  const state = loadState(options.db)
  const input = buildBrainInput({
    state,
    goalId: options.goalId,
    agents: options.agents,
    ...(options.peers === undefined ? {} : { peers: options.peers }),
    pending: pendingDecisionPoints(options.db, options.goalId).map((item) => ({
      id: item.id,
      reason: item.reason,
      createdAt: item.createdAt,
    })),
    budget,
    stateVersion: lastSeq(options.db),
    ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
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
    if (!finish('failed', 'BUDGET_EXHAUSTED')) return undefined
    return { point, input, actions: [], validation, record }
  }

  let rawActions: BrainAction[]
  try {
    rawActions = await withTimeout(
      options.brain.step(input, options.onDelta),
      budget.timeoutMs,
      'brain.step',
    )
  } catch (error) {
    // claim 失效也要继续抛：本回合的 Brain 错误必须让调用方看到。
    finish('failed', error instanceof Error ? error.message : String(error))
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
    if (!finish('failed', 'stale_state_version')) return undefined
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
  /* 第二次模型调用前先确认仍持有 claim：被接管就不必再烧 token。 */
  if (!renewDecisionClaim(options.db, point.id, claimToken)) return undefined
  /* explain 也会挂：给它同样的回合预算上限。 */
  const rationales = await withTimeout(
    options.brain.explain(input),
    budget.timeoutMs,
    'brain.explain',
  ).catch(() => [])
  /* step + explain 可能吃掉整段租约：收尾前再续一次，缩小被判过期的窗口。
     续租失败说明 claim 已被回收/接管，本轮动作丢弃。 */
  if (!renewDecisionClaim(options.db, point.id, claimToken)) return undefined
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

  const applied = finish(
    validation.ok ? 'done' : 'failed',
    validation.ok ? undefined : validation.errors.map((item) => item.message).join('; '),
  )
  if (!applied) {
    /* claim 被回收并接管：本轮动作一律不生效，留一条 DecisionRecord 说明丢弃原因。 */
    recordDecision(options.db, {
      goalId: options.goalId,
      ...(options.planRevision === undefined ? {} : { planRevision: options.planRevision }),
      type: 'abort',
      rationale: '决策点 claim 已被回收/接管，本轮动作丢弃',
      inputs: { decisionPointId: point.id, stateVersion: input.stateVersion, actions: [] },
    })
    return undefined
  }

  return { point, input, actions: validation.actions, validation, record }
}
