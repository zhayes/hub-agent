import type { ChatMessage, ChatThread } from '../../domain/chat'
import { asChatThreadId, type ChatThreadId } from '../../domain/ids'
import type { SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import type { Db } from '../../storage/db'
import {
  appendChatMessage,
  type ChatThreadSummary,
  createChatThread,
  getChatThread,
  listChatMessages,
  listChatThreads,
  updateChatThread,
} from '../../storage/queries/chat'
import { getTaskEvidence } from '../../storage/queries/evidence'
import { listAgents, resolveAgent } from '../agent-registry'
import { runGoalWithBrain } from '../brain-run'
import { answerClarification } from '../clarify'

export interface ChatServiceOptions {
  db: Db
  provider: SandboxProvider
  clientVersion: string
  worktree?: string
}

export interface CreateThreadInput {
  title?: string
}

export interface PostMessageInput {
  text: string
  mode?: 'run' | 'ask'
  agentName?: string
}

export class ChatService {
  private readonly active = new Set<string>()

  constructor(private readonly options: ChatServiceOptions) {}

  createThread(input: CreateThreadInput = {}): ChatThread {
    return createChatThread(this.options.db, {
      title: input.title?.trim().slice(0, 120) || 'New thread',
    })
  }

  listThreads(limit = 50): ChatThreadSummary[] {
    return listChatThreads(this.options.db, limit)
  }

  getThread(
    id: string,
    page: { limit?: number; before?: string } = {},
  ): { thread: ChatThread; messages: ChatMessage[] } | undefined {
    const thread = getChatThread(this.options.db, asChatThreadId(id))
    if (thread === undefined) return undefined
    return {
      thread,
      messages: listChatMessages(this.options.db, thread.id, {
        limit: page.limit ?? 100,
        ...(page.before === undefined ? {} : { before: page.before }),
      }),
    }
  }

  async postMessage(id: string, input: PostMessageInput): Promise<ChatThread> {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    const text = input.text.trim()
    if (text.length === 0) {
      throw new HubError('ACTION_REJECTED', 'message text is empty', { threadId: id })
    }
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }

    const userMessage = appendChatMessage(this.options.db, {
      threadId,
      role: 'user',
      kind: 'text',
      content: text,
      ...(thread.goalId === undefined ? {} : { goalId: thread.goalId }),
      ...(thread.taskId === undefined ? {} : { taskId: thread.taskId }),
    })
    if (thread.title === 'New thread') {
      updateChatThread(this.options.db, threadId, { title: text.slice(0, 72) })
    }

    if (input.mode === 'ask') {
      this.answerFromSnapshot(threadId, text)
      return getChatThread(this.options.db, threadId) ?? thread
    }

    const agents = listAgents(this.options.db)
    const agent =
      input.agentName === undefined ? agents[0] : resolveAgent(this.options.db, input.agentName)
    if (agent === undefined) {
      appendChatMessage(this.options.db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: 'No Agent is registered. Add one with `hubagent agent add`.',
      })
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }

    this.active.add(id)
    updateChatThread(this.options.db, threadId, { status: 'active' })
    void this.run(threadId, text, agent.name, userMessage)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  async answer(id: string, clarificationId: string, answer: string): Promise<ChatThread> {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    const row = this.options.db
      .prepare('SELECT execution_id FROM clarifications WHERE id = ?')
      .get(clarificationId) as { execution_id: string | null } | undefined
    answerClarification(this.options.db, {
      questionId: clarificationId,
      answer,
      ...(row?.execution_id === null || row?.execution_id === undefined
        ? {}
        : { executionId: row.execution_id }),
    })
    return this.resume(id)
  }

  async resume(id: string): Promise<ChatThread> {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }
    const messages = listChatMessages(this.options.db, threadId)
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    if (lastUser === undefined) {
      throw new HubError('ACTION_REJECTED', 'thread has no user message', { threadId: id })
    }
    const agent = listAgents(this.options.db)[0]
    if (agent === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    this.active.add(id)
    updateChatThread(this.options.db, threadId, { status: 'active' })
    void this.run(threadId, lastUser.content, agent.name, lastUser)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  private answerFromSnapshot(threadId: ChatThreadId, text: string): void {
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) return
    const evidence =
      thread.taskId === undefined ? undefined : getTaskEvidence(this.options.db, thread.taskId)
    const task = evidence?.task
    const checks = evidence?.verifications.flatMap((run) => run.checks) ?? []
    const passed = checks.filter((check) => check.passed).length
    const content =
      task === undefined
        ? `No task is linked to this thread yet. Received: ${text.slice(0, 160)}`
        : `Task ${task.status}. Evidence: ${passed}/${checks.length} checks passed.`
    appendChatMessage(this.options.db, {
      threadId,
      role: 'assistant',
      kind: 'text',
      content,
      ...(thread.goalId === undefined ? {} : { goalId: thread.goalId }),
      ...(thread.taskId === undefined ? {} : { taskId: thread.taskId }),
    })
  }

  private async run(
    threadId: ChatThreadId,
    objective: string,
    agentName: string,
    userMessage: ChatMessage,
  ): Promise<void> {
    const db = this.options.db
    try {
      const agent = resolveAgent(db, agentName)
      const agents = listAgents(db)
      const result = await runGoalWithBrain({
        db,
        provider: this.options.provider,
        brain: undefined,
        agent,
        availableAgents: agents,
        objective,
        worktree: this.options.worktree ?? process.cwd(),
        checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
        clientVersion: this.options.clientVersion,
        completeOnSuccess: true,
        onGoalCreated: (goalId) => {
          updateChatThread(db, threadId, { goalId })
        },
        onTaskCreated: ({ goalId, taskId }) => {
          updateChatThread(db, threadId, { goalId, taskId, status: 'active' })
          appendChatMessage(db, {
            threadId,
            role: 'assistant',
            kind: 'task',
            content: `Task created: ${taskId}`,
            goalId,
            taskId,
          })
        },
      })
      const thread = getChatThread(db, threadId)
      updateChatThread(db, threadId, {
        status: result.ok
          ? 'completed'
          : result.stopReason === 'waiting_input'
            ? 'waiting'
            : 'failed',
        ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      })
      if (result.approval !== undefined) {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'approval',
          content: `${result.approval.reason}: ${result.approval.resource}`,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          taskId: result.taskId,
          approvalId: result.approval.id,
        })
      }
      if (result.clarification !== undefined) {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'clarification',
          content: result.clarification.question,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          taskId: result.taskId,
          clarificationId: result.clarification.id,
        })
      }
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'result',
        content: result.ok
          ? `Task completed: ${result.taskId}`
          : `Task ${result.stopReason}: ${result.taskId}`,
        ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
        taskId: result.taskId,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      updateChatThread(db, threadId, { status: 'failed' })
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: message,
      })
    } finally {
      this.active.delete(userMessage.threadId)
    }
  }
}

export function createChatService(options: ChatServiceOptions): ChatService {
  return new ChatService(options)
}
