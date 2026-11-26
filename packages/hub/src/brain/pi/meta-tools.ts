import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { type Static, type TSchema, Type } from 'typebox'
import type { BrainAction, BrainInput, SubtaskView } from '../types'

export interface MetaToolState {
  actions: BrainAction[]
}

export interface MetaTools {
  tools: ToolDefinition<TSchema, unknown>[]
  state: MetaToolState
}

/**
 * Pi 的稳定元工具（PRD §13.5）。
 * 工具只读取快照或记录 intent；真正的 delegate/cancel/revise_plan 由 Runtime 校验后执行。
 */
export function createMetaTools(input: BrainInput): MetaTools {
  const state: MetaToolState = { actions: [] }
  const subtasks = input.tasks.flatMap((task) => task.subtasks)

  const reply = Type.Object({ text: Type.String() })
  const discover = Type.Object({})
  const agentDetail = Type.Object({ agentId: Type.String() })
  const taskResult = Type.Object({ subtaskId: Type.String() })
  const awaitAny = Type.Object({ timeoutMs: Type.Optional(Type.Number()) })
  const draft = Type.Object({
    title: Type.String(),
    description: Type.String(),
    requiredCapabilities: Type.Optional(Type.Array(Type.String())),
    maxAttempts: Type.Optional(Type.Number()),
  })
  const revise = Type.Object({
    subtasks: Type.Array(draft),
    reason: Type.String(),
  })
  const delegate = Type.Object({
    subtaskId: Type.String(),
    objective: Type.String(),
    agentId: Type.Optional(Type.String()),
  })
  const cancel = Type.Object({ executionId: Type.String(), reason: Type.String() })
  const request = Type.Object({
    kind: Type.Optional(Type.Union([Type.Literal('clarify'), Type.Literal('decide')])),
    question: Type.String(),
    options: Type.Optional(Type.Array(Type.String())),
    executionId: Type.Optional(Type.String()),
  })

  const tools: ToolDefinition<TSchema, unknown>[] = [
    {
      name: 'reply',
      label: 'Reply to user',
      description:
        'Answer the user directly in the conversation. Use this instead of a plan when no local work is needed.',
      promptSnippet: 'reply: answer the user without creating a task',
      parameters: reply,
      execute: async (_id, params: Static<typeof reply>) => {
        state.actions.push({ type: 'reply', text: params.text })
        return text({ queued: 'reply' })
      },
    },
    {
      name: 'discover_agents',
      label: 'Discover agents',
      description: 'List available local agents and their capabilities.',
      promptSnippet: 'discover_agents: list available agents',
      parameters: discover,
      execute: async () =>
        text({
          agents: input.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            capabilities: agent.capabilities ?? null,
          })),
        }),
    },
    {
      name: 'get_agent_detail',
      label: 'Get agent detail',
      description: 'Get one agent summary from the current snapshot.',
      parameters: agentDetail,
      execute: async (_id, params: Static<typeof agentDetail>) => {
        const agent = input.agents.find((item) => item.id === params.agentId)
        return text(agent === undefined ? { error: 'agent not found' } : { agent })
      },
    },
    {
      name: 'get_task_result',
      label: 'Get task result',
      description: 'Get a subtask status, evidence summary and verification verdict.',
      parameters: taskResult,
      execute: async (_id, params: Static<typeof taskResult>) => {
        const subtask = subtasks.find((item) => item.id === params.subtaskId)
        return text(subtask === undefined ? { error: 'subtask not found' } : summarize(subtask))
      },
    },
    {
      name: 'await_any',
      label: 'Await any',
      description:
        'Return terminal subtasks immediately, or the pending list. Never blocks the Brain turn.',
      parameters: awaitAny,
      execute: async () => {
        const reached = subtasks
          .filter((subtask) => isTerminal(subtask))
          .map((subtask) => ({ subtaskId: subtask.id, status: subtask.status }))
        const pending = subtasks
          .filter((subtask) => !isTerminal(subtask))
          .map((subtask) => subtask.id)
        return text({ reached, pending, timedOut: false })
      },
    },
    {
      name: 'revise_plan',
      label: 'Revise plan',
      description:
        'Submit a plan revision. Runtime validates and persists it; this tool only records intent.',
      parameters: revise,
      execute: async (_id, params: Static<typeof revise>) => {
        state.actions.push({
          type: 'revise_plan',
          subtasks: params.subtasks.map((item) => ({
            title: item.title,
            description: item.description,
            requiredCapabilities: item.requiredCapabilities ?? [],
            ...(item.maxAttempts === undefined ? {} : { maxAttempts: item.maxAttempts }),
          })),
          reason: params.reason,
        })
        return text({ queued: 'revise_plan', subtasks: params.subtasks.length })
      },
    },
    {
      name: 'delegate_task',
      label: 'Delegate task',
      description:
        'Request delegation of an existing subtask. Runtime validates and executes; this tool only records intent.',
      parameters: delegate,
      execute: async (_id, params: Static<typeof delegate>) => {
        state.actions.push({
          type: 'delegate',
          request: {
            subtaskId: params.subtaskId,
            objective: params.objective,
            ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
          },
        })
        return text({ queued: 'delegate', subtaskId: params.subtaskId })
      },
    },
    {
      name: 'cancel_task',
      label: 'Cancel task',
      description: 'Request cancellation of an execution. Runtime validates and audits it.',
      parameters: cancel,
      execute: async (_id, params: Static<typeof cancel>) => {
        state.actions.push({
          type: 'cancel',
          executionId: params.executionId,
          reason: params.reason,
        })
        return text({ queued: 'cancel', executionId: params.executionId })
      },
    },
    {
      name: 'request_human',
      label: 'Request human',
      description: 'Ask the user a clarify/decide question. Runtime routes the answer.',
      parameters: request,
      execute: async (_id, params: Static<typeof request>) => {
        state.actions.push({
          type: 'request_human',
          question: params.question,
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.options === undefined ? {} : { options: params.options }),
          ...(params.executionId === undefined ? {} : { executionId: params.executionId }),
        })
        return text({ queued: 'request_human' })
      },
    },
  ]

  return { tools, state }
}

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: {},
  }
}

function isTerminal(subtask: SubtaskView): boolean {
  return ['succeeded', 'failed', 'canceled', 'skipped'].includes(subtask.status)
}

function summarize(subtask: SubtaskView) {
  return {
    id: subtask.id,
    title: subtask.title,
    status: subtask.status,
    required: subtask.required,
    execution: subtask.execution ?? null,
  }
}
