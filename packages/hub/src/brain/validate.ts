import { z } from 'zod'
import type { BrainAction, BrainBudget, BrainInput, SubtaskDraft } from './types'

const draftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  requiredCapabilities: z.array(z.string()),
  maxAttempts: z.number().int().min(1).optional(),
})

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reply'),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal('revise_plan'),
    subtasks: z.array(draftSchema).min(1).max(8),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('delegate'),
    request: z.object({
      subtaskId: z.string().min(1),
      objective: z.string().min(1),
      agentId: z.string().min(1).optional(),
      peerId: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal('cancel'),
    executionId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('accept'),
    subtaskId: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.object({
    type: z.literal('reject'),
    subtaskId: z.string().min(1),
    reason: z.string().min(1),
    next: z.enum(['retry', 'replan']),
  }),
  z.object({
    type: z.literal('request_human'),
    kind: z.enum(['clarify', 'decide']).optional(),
    question: z.string().min(1),
    options: z.array(z.string()).optional(),
    questionId: z.string().min(1).optional(),
    executionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('finish'),
    summary: z.string().min(1),
  }),
])

export interface ActionValidationError {
  index: number
  message: string
}

export interface ActionValidation {
  ok: boolean
  actions: BrainAction[]
  errors: ActionValidationError[]
}

function subtasksOf(input: BrainInput) {
  return input.tasks.flatMap((task) => task.subtasks)
}

function executionsOf(input: BrainInput) {
  return input.tasks.flatMap((task) =>
    task.subtasks.flatMap((subtask) =>
      subtask.execution === undefined ? [] : [subtask.execution],
    ),
  )
}

/**
 * 动作校验顺序（PRD §6.10.1）：schema → 权限 → 预算 → 幂等。
 * 校验只返回可执行动作与错误；不产生副作用。
 */
export function validateBrainActions(
  input: BrainInput,
  rawActions: readonly unknown[],
  budget: BrainBudget,
): ActionValidation {
  const errors: ActionValidationError[] = []
  const actions: BrainAction[] = []

  if (rawActions.length > budget.maxActions) {
    return {
      ok: false,
      actions: [],
      errors: [
        {
          index: -1,
          message: `动作数 ${rawActions.length} 超过单回合上限 ${budget.maxActions}`,
        },
      ],
    }
  }

  const knownSubtasks = new Set(subtasksOf(input).map((subtask) => subtask.id))
  const knownExecutions = new Set(executionsOf(input).map((execution) => execution.id))
  const knownAgents = new Map(input.agents.map((agent) => [agent.id, agent]))
  const knownPeers = new Map((input.peers ?? []).map((peer) => [peer.id, peer]))
  const seen = new Set<string>()

  for (const [index, raw] of rawActions.entries()) {
    const parsed = actionSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push({ index, message: parsed.error.issues.map((issue) => issue.message).join('; ') })
      continue
    }
    const action = parsed.data as BrainAction

    // 权限/引用校验
    if (action.type === 'revise_plan') {
      const titles = new Set<string>()
      for (const draft of action.subtasks) {
        if (titles.has(draft.title)) {
          errors.push({ index, message: `revise_plan 存在重复标题：${draft.title}` })
          break
        }
        titles.add(draft.title)
      }
      if (errors.some((error) => error.index === index)) continue
    }

    if (action.type === 'delegate') {
      if (!knownSubtasks.has(action.request.subtaskId)) {
        errors.push({
          index,
          message: `delegate 引用了不存在的子任务：${action.request.subtaskId}`,
        })
        continue
      }
      /* 本地与远程只能二选一：两个都给会让“到底谁执行”含糊。 */
      if (action.request.agentId !== undefined && action.request.peerId !== undefined) {
        errors.push({ index, message: 'delegate 的 agentId 与 peerId 只能二选一' })
        continue
      }
      if (action.request.peerId !== undefined) {
        const peer = knownPeers.get(action.request.peerId)
        if (peer === undefined) {
          /* 未知/未授权的对端直接拒，**不能**退回本地 Agent。 */
          errors.push({
            index,
            message: `delegate 引用了未知远程对端：${action.request.peerId}`,
          })
          continue
        }
      }
      if (action.request.agentId !== undefined) {
        const agent = knownAgents.get(action.request.agentId)
        if (agent === undefined) {
          errors.push({ index, message: `delegate 引用了未知 Agent：${action.request.agentId}` })
          continue
        }
        if (agent.status === 'offline' || agent.status === 'error') {
          errors.push({ index, message: `Agent 不可用：${action.request.agentId}` })
          continue
        }
      }
    }

    if (
      (action.type === 'accept' || action.type === 'reject') &&
      !knownSubtasks.has(action.subtaskId)
    ) {
      errors.push({ index, message: `${action.type} 引用了不存在的子任务：${action.subtaskId}` })
      continue
    }

    if (action.type === 'cancel' && !knownExecutions.has(action.executionId)) {
      errors.push({ index, message: `cancel 引用了不存在的执行：${action.executionId}` })
      continue
    }

    if (
      action.type === 'request_human' &&
      action.executionId !== undefined &&
      !knownExecutions.has(action.executionId)
    ) {
      errors.push({ index, message: `request_human 引用了不存在的执行：${action.executionId}` })
      continue
    }

    // 幂等：同一回合内重复动作只保留一次
    const key = JSON.stringify(action)
    if (seen.has(key)) {
      errors.push({ index, message: '重复动作（同回合幂等去重）' })
      continue
    }
    seen.add(key)
    actions.push(action)
  }

  return { ok: errors.length === 0, actions, errors }
}

export function estimateInputTokens(input: BrainInput): number {
  return Math.ceil(JSON.stringify(input).length / 4)
}

export function draftToSubtask(draft: SubtaskDraft): SubtaskDraft {
  return {
    title: draft.title,
    description: draft.description,
    requiredCapabilities: [...draft.requiredCapabilities],
    ...(draft.maxAttempts === undefined ? {} : { maxAttempts: draft.maxAttempts }),
  }
}
