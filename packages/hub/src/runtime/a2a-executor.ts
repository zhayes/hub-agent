import { type Message, Role, type Task, TaskState } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { newId } from '../shared/id'

export type InboundOutcome =
  | { state: 'completed'; summary?: string }
  | { state: 'failed'; error: string }
  | { state: 'input_required'; question: string }

export interface InboundTaskRunner {
  /**
   * 执行一次入站任务。实现方（组合根注入）负责建本地 Goal/Task 并等待结果，
   * 这里只关心“对外该报什么状态”。失败不得抛出，按 `failed` 返回。
   */
  run(input: {
    taskId: string
    contextId: string
    objective: string
    peerId: string
  }): Promise<InboundOutcome>
  /** 取消；SDK 的 cancel 只给 taskId，所以要连 contextId 一起取回。 */
  cancel(taskId: string): Promise<{ contextId: string }>
}

/**
 * A2A 入站执行器：把 SDK 的 `AgentExecutor` 接到本地 Runtime。
 *
 * 协议要求（必须遵守，否则 SDK 会拒绝这条流）：
 * - 首帧必须是 `task` 或 `message`，不能直接发 `statusUpdate`；
 * - 终态之后不再发事件；
 * - `input_required` / `auth_required` 是可续状态，不视为结束。
 */
export function createA2aExecutor(runner: InboundTaskRunner): AgentExecutor {
  return {
    async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const now = (): string => new Date().toISOString()
      const taskId = context.taskId
      const contextId = context.contextId
      const peerId = context.context.user?.userName ?? 'unknown'

      const task: Task = context.task ?? {
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
        artifacts: [],
        history: [],
        metadata: {},
      }

      /* 首帧：任务快照。缺了这帧 SDK 会拒绍整条流。 */
      bus.publish(AgentEvent.task(task))
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() },
          metadata: {},
        }),
      )

      let outcome: InboundOutcome
      try {
        outcome = await runner.run({
          taskId,
          contextId,
          objective: objectiveOf(context),
          peerId,
        })
      } catch (error) {
        outcome = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
      }

      const state =
        outcome.state === 'completed'
          ? TaskState.TASK_STATE_COMPLETED
          : outcome.state === 'failed'
            ? TaskState.TASK_STATE_FAILED
            : TaskState.TASK_STATE_INPUT_REQUIRED

      const text =
        outcome.state === 'completed'
          ? outcome.summary
          : outcome.state === 'failed'
            ? outcome.error
            : outcome.question

      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state,
            timestamp: now(),
            message: text === undefined ? undefined : agentMessage(text, contextId, taskId),
          },
          metadata: {},
        }),
      )
    },

    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      const { contextId } = await runner.cancel(taskId)
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            timestamp: new Date().toISOString(),
            message: agentMessage('已按请求取消', contextId, taskId),
          },
          metadata: {},
        }),
      )
    },
  }
}

/** 从入站消息里取目标文本；多段时按行拼接，忽略非文本段（文件在 A3 再处理）。 */
function objectiveOf(context: RequestContext): string {
  const parts = context.userMessage.parts ?? []
  const texts = parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : undefined))
    .filter((text): text is string => text !== undefined && text !== '')
  return texts.length > 0 ? texts.join('\n') : '(空请求)'
}

function agentMessage(text: string, contextId: string, taskId: string): Message {
  return {
    messageId: newId(),
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    contextId,
    taskId,
    extensions: [],
    referenceTaskIds: [],
    metadata: {},
  }
}
