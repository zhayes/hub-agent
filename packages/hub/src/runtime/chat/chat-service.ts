import type { ChatTurn, OrchestratorBrain } from '../../brain/types'
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
import { listAgents, resolveAgent, setAgentStatus } from '../agent-registry'
import { runGoalWithBrain } from '../brain-run'
import { answerClarification } from '../clarify'

export interface ChatServiceOptions {
  db: Db
  provider: SandboxProvider
  clientVersion: string
  worktree?: string
  /** 测试注入；缺省由 runGoalWithBrain 走 createBrainFromEnv（Pi）。 */
  brain?: OrchestratorBrain
}

export interface CreateThreadInput {
  title?: string
}

export interface PostMessageInput {
  text: string
  agentName?: string
}

/** 送给 Brain 的对话窗口：够用就好，别把整条 thread 塞进快照。 */
const HISTORY_MESSAGES = 40
const HISTORY_TURNS = 24
const HISTORY_CHARS = 6_000

/**
 * 控制台对话：每条用户消息都是一次 Brain 回合。
 *
 * Brain 可以直接 reply（问答/闲聊），也可以拆计划交给本机 Agent 执行；
 * 需要用户补充信息时落 Clarification，由 UI 渲染成可点选项。
 * 只有真正执行时才建 Task，不存在“问一句话也必须建任务”的路径。
 */
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

    /* 历史要在写入本条消息之前取：本条就是 goal.intent，不要再重复进对话。 */
    const conversation = this.history(threadId)
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

    const agent = this.pickAgent(input.agentName)
    if (agent === undefined) {
      appendChatMessage(this.options.db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: 'No Agent is registered. Add one with `hubagent agent add`.',
      })
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }

    this.start(threadId, text, agent.name, userMessage, conversation)
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
    /* 答案进入对话历史，模型下一回合能看到“我问了什么、用户答了什么”。 */
    const conversation = this.history(threadId)
    const userMessage = appendChatMessage(this.options.db, {
      threadId,
      role: 'user',
      kind: 'text',
      content: answer,
    })
    const agent = this.pickAgent()
    if (agent === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    this.start(threadId, answer, agent.name, userMessage, conversation)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /** 审批后继续：重跑最后一条用户消息（新 attempt，见 ADR 0018）。 */
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
    const index = messages.findLastIndex((message) => message.role === 'user')
    const lastUser = index === -1 ? undefined : messages[index]
    if (lastUser === undefined) {
      throw new HubError('ACTION_REJECTED', 'thread has no user message', { threadId: id })
    }
    const agent = this.pickAgent()
    if (agent === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    const conversation = this.turnsOf(messages.slice(0, index))
    this.start(threadId, lastUser.content, agent.name, lastUser, conversation)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  private pickAgent(name?: string) {
    return name === undefined ? listAgents(this.options.db)[0] : resolveAgent(this.options.db, name)
  }

  private start(
    threadId: ChatThreadId,
    objective: string,
    agentName: string,
    userMessage: ChatMessage,
    conversation: ChatTurn[],
  ): void {
    this.active.add(threadId)
    updateChatThread(this.options.db, threadId, { status: 'active' })
    void this.run(threadId, objective, agentName, userMessage, conversation)
  }

  /**
   * 只把用户看得见的话带进上下文：用户文本、助手回复、澄清问题。
   * task 卡片、审批卡片和旧错误是 UI 噪声，喂给模型只会干扰判断。
   */
  private history(threadId: ChatThreadId): ChatTurn[] {
    return this.turnsOf(listChatMessages(this.options.db, threadId, { limit: HISTORY_MESSAGES }))
  }

  private turnsOf(messages: readonly ChatMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = []
    for (const message of messages) {
      if (message.role === 'system') continue
      if (message.kind !== 'text' && message.kind !== 'clarification') continue
      const content = message.content.trim()
      if (content === '') continue
      turns.push({ role: message.role, content: content.slice(0, 4_000) })
    }
    const windowed = turns.slice(-HISTORY_TURNS)
    while (windowed.length > 0 && this.sizeOf(windowed) > HISTORY_CHARS) windowed.shift()
    return windowed
  }

  private sizeOf(turns: readonly ChatTurn[]): number {
    return turns.reduce((total, turn) => total + turn.content.length, 0)
  }

  private async run(
    threadId: ChatThreadId,
    objective: string,
    agentName: string,
    userMessage: ChatMessage,
    conversation: ChatTurn[],
  ): Promise<void> {
    const db = this.options.db
    try {
      const agent = resolveAgent(db, agentName)
      const agents = listAgents(db)
      const result = await runGoalWithBrain({
        db,
        provider: this.options.provider,
        brain: this.options.brain,
        agent,
        availableAgents: agents,
        objective,
        conversation,
        worktree: this.options.worktree ?? process.cwd(),
        checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
        clientVersion: this.options.clientVersion,
        completeOnSuccess: true,
        onProgress: (step) => {
          appendChatMessage(db, {
            threadId,
            role: 'assistant',
            kind: 'progress',
            content: step.text,
            ...(step.agent === undefined ? {} : { agentName: step.agent }),
          })
        },
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
      const waiting =
        result.stopReason === 'waiting_input' || result.stopReason === 'waiting_approval'
      updateChatThread(db, threadId, {
        status:
          result.ok || result.reply !== undefined ? 'completed' : waiting ? 'waiting' : 'failed',
        ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        ...(result.goalId === undefined ? {} : { goalId: result.goalId }),
      })
      if (result.approval !== undefined) {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'approval',
          content: `${result.approval.reason}: ${result.approval.resource}`,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          approvalId: result.approval.id,
        })
      } else if (result.clarification !== undefined) {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'clarification',
          content: result.clarification.question,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          clarificationId: result.clarification.id,
        })
      } else if (result.reply !== undefined) {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'text',
          content: result.reply,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        })
      } else {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: result.ok ? 'result' : 'error',
          content: result.ok
            ? `任务完成：${result.taskId ?? ''}`
            : `任务没有完成（${result.stopReason}）${result.taskId === undefined ? '' : `，任务 ${result.taskId} 还留着现场`}。`,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      /* Agent 需要登录不是“任务失败”，是可操作的等待态：卡片里直接授权后重试。 */
      if (/authentication required|not authenticated|login required|需要登录/i.test(message)) {
        setAgentStatus(db, agentName, 'needs_auth')
        updateChatThread(db, threadId, { status: 'waiting' })
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'auth',
          content: message,
          agentName,
        })
      } else {
        updateChatThread(db, threadId, { status: 'failed' })
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'error',
          content: message,
        })
      }
    } finally {
      this.active.delete(userMessage.threadId)
    }
  }
}

export function createChatService(options: ChatServiceOptions): ChatService {
  return new ChatService(options)
}
