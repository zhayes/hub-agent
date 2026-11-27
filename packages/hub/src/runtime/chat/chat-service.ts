import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AcpExecutionEvent } from '../../adapters/acp/event'
import type { BrainDelta, ChatTurn, OrchestratorBrain } from '../../brain/types'
import type { ChatMessage, ChatProgressStage, ChatRunSettings, ChatThread } from '../../domain/chat'
import { DEFAULT_RUN_SETTINGS } from '../../domain/chat'
import type { Approval } from '../../domain/entities'
import {
  asChatMessageId,
  asChatThreadId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  type ChatThreadId,
} from '../../domain/ids'
import type { PermissionMode } from '../../domain/status'
import type { SandboxProvider } from '../../sandbox/types'
import { HubError } from '../../shared/errors'
import type { Db } from '../../storage/db'
import {
  appendChatMessage,
  type ChatThreadSummary,
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatMessages,
  listChatThreads,
  updateChatMessage,
  updateChatThread,
} from '../../storage/queries/chat'
import { loadState } from '../../storage/queries/state'
import { appendEvent } from '../../storage/write/events'
import { runAcpWithRetry } from '../acp-retry'
import { listAgents, resolveAgent, setAgentStatus } from '../agent-registry'
import type { RunGoalWithBrainOptions } from '../brain-run'
import { runGoalWithBrain } from '../brain-run'
import { answerClarification } from '../clarify'
import { verdictLabel } from '../labels'
import { failTask } from '../recovery/fail'
import { resumeExecution } from '../resume-execution'
import { completeTaskAfterDelivery } from '../workspace/finalize'
import { collectAgentOutputs } from './agent-outputs'
import { brainBudget, scopeAgents, verificationChecks } from './run-settings'

export interface ChatServiceOptions {
  db: Db
  provider: SandboxProvider
  clientVersion: string
  worktree?: string
  /** 测试注入；缺省由 runGoalWithBrain 走 createBrainFromEnv（Pi）。 */
  brain?: OrchestratorBrain
  /** 可委托的远程对端（A3）：给了 Brain 才能在 delegate 里用 peerId。 */
  remote?: RunGoalWithBrainOptions['remote']
}

/** 工作区必须是绝对路径且已存在的目录。 */
function assertWorkspace(worktree: string): string {
  if (!isAbsolute(worktree)) {
    throw new HubError('CONFIG_INVALID', `工作区必须是绝对路径：${worktree}`, { worktree })
  }
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(worktree)
  } catch {
    throw new HubError('CONFIG_INVALID', `工作区不存在：${worktree}`, { worktree })
  }
  if (!stats.isDirectory()) {
    throw new HubError('CONFIG_INVALID', `工作区不是目录：${worktree}`, { worktree })
  }
  return worktree
}

export interface CreateThreadInput {
  title?: string
  /** 会话工作区（绝对路径，必须已存在）。**必填**：没有它会拒绝执行，绝不回落到 cwd。 */
  worktree?: string
  permissionMode?: PermissionMode
  runSettings?: ChatRunSettings
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
function toolDetail(raw: unknown): string | undefined {
  const value = raw as
    | {
        kind?: string
        rawInput?: Record<string, unknown>
        content?: Array<{ content?: { text?: string } }>
      }
    | undefined
  const input = value?.rawInput ?? {}
  const command = typeof input.command === 'string' ? input.command : undefined
  const path =
    typeof (input.path ?? input.file_path ?? input.filePath) === 'string'
      ? String(input.path ?? input.file_path ?? input.filePath)
      : undefined
  const output = (value?.content ?? [])
    .map((item) => item.content?.text)
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .join('\n')
  const payload = {
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
    ...(value?.kind === undefined ? {} : { kind: value.kind }),
    ...(output === '' ? {} : { output: output.slice(0, 8_000) }),
  }
  return Object.keys(payload).length === 0 ? undefined : JSON.stringify(payload)
}

function mergeToolDetail(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (previous === undefined) return next
  if (next === undefined) return previous
  try {
    return JSON.stringify({
      ...(JSON.parse(previous) as Record<string, unknown>),
      ...(JSON.parse(next) as Record<string, unknown>),
    })
  } catch {
    return next
  }
}

function toolLabel(raw: unknown): string {
  const value = raw as { kind?: string; rawInput?: Record<string, unknown> } | undefined
  const input = value?.rawInput
  if (input !== undefined) {
    const command = input.command ?? input.cmd
    if (typeof command === 'string' && command.trim() !== '') {
      return `执行 ${command.split('\n')[0]?.slice(0, 80) ?? ''}`
    }
    const path = input.path ?? input.file_path ?? input.filePath
    if (typeof path === 'string' && path !== '') {
      const verb = value?.kind === 'edit' ? '编辑' : value?.kind === 'read' ? '读取' : '访问'
      return `${verb} ${path}`
    }
  }
  switch (value?.kind) {
    case 'execute':
      return '执行命令'
    case 'read':
      return '读取文件'
    case 'edit':
      return '编辑文件'
    case 'search':
      return '搜索'
    case 'fetch':
      return '抓取'
    default:
      return '工具调用'
  }
}

export class ChatService {
  private readonly active = new Set<string>()

  constructor(private readonly options: ChatServiceOptions) {}

  createThread(input: CreateThreadInput = {}): ChatThread {
    const raw = input.worktree?.trim()
    /* 给了就必须是合法目录；没给则允许创建，但这样的会话**不能执行**（fail-closed）。 */
    const worktree = raw === undefined || raw === '' ? undefined : assertWorkspace(raw)

    return createChatThread(this.options.db, {
      title: input.title?.trim().slice(0, 120) || 'New thread',
      ...(worktree === undefined ? {} : { worktree }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.runSettings === undefined ? {} : { runSettings: input.runSettings }),
    })
  }

  /**
   * 改运行设置（验收命令 / 可用 Agent / 预算）。只影响后续回合。
   *
   * 正在跑的回合不追溯：换掉验收命令去影响已派发的执行，等于事后改判。
   */
  setRunSettings(id: string, settings: ChatRunSettings): ChatThread {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    updateChatThread(this.options.db, threadId, { runSettings: settings })
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /**
   * 会话的工作区与权限档。
   *
   * 历史会话可能没有 worktree（迁移前的数据）——此时**拒绝执行**，
   * 而不是默默用 `process.cwd()` 跑到 HubAgent 自己身上。
   */
  private workspaceOf(threadId: string): { worktree: string; permissionMode: PermissionMode } {
    const thread = getChatThread(this.options.db, asChatThreadId(threadId))
    const worktree = thread?.worktree
    if (worktree === undefined || worktree === '') {
      throw new HubError('CONFIG_INVALID', '该会话还没有工作区，请先选择文件夹再发送', {})
    }
    return { worktree, permissionMode: thread?.permissionMode ?? 'workspace-write' }
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

  renameThread(id: string, title: string): ChatThread {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    const value = title.trim().slice(0, 120)
    if (value.length === 0) {
      throw new HubError('ACTION_REJECTED', 'thread title is empty', { threadId: id })
    }
    updateChatThread(this.options.db, threadId, { title: value })
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /** 归档：从侧栏消失，消息保留；运行中的 thread 不允许归档，避免写一半没人看。 */
  archiveThread(id: string): ChatThread {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }
    if (thread.archivedAt === undefined) {
      updateChatThread(this.options.db, threadId, { archivedAt: new Date().toISOString() })
    }
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /** 切换会话权限档；只影响后续回合，不追溯正在跑的执行。 */
  setPermissionMode(id: string, mode: PermissionMode): ChatThread {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    if (thread.permissionMode !== mode) {
      updateChatThread(this.options.db, threadId, { permissionMode: mode })
    }
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /** 给旧会话补齐工作区（迁移前创建的会话没有 worktree）。 */
  setWorkspace(id: string, worktree: string): ChatThread {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }
    const value = assertWorkspace(worktree.trim())
    if (thread.worktree !== value) {
      updateChatThread(this.options.db, threadId, { worktree: value })
    }
    return getChatThread(this.options.db, threadId) ?? thread
  }

  deleteThread(id: string): void {
    const threadId = asChatThreadId(id)
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }
    if (!deleteChatThread(this.options.db, threadId)) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
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

    const allowed = scopeAgents(listAgents(this.options.db), thread.runSettings)
    if (allowed.length === 0) {
      appendChatMessage(this.options.db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: '运行设置里允许的 Agent 都已不存在，请重新选择可用 Agent。',
      })
      throw new HubError('NO_AGENT_AVAILABLE', '运行设置里允许的 Agent 不存在', { threadId: id })
    }
    const agent = input.agentName === undefined ? allowed[0] : this.pickAgent(input.agentName)
    if (agent === undefined) {
      appendChatMessage(this.options.db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: 'No Agent is registered. Add one with `hubagent agent add`.',
      })
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    /* 设置里只放行了部分 Agent 时，显式点名的那个也必须在名单里。 */
    if (!allowed.some((item) => item.name === agent.name)) {
      const names = allowed.map((item) => item.name).join(' / ')
      appendChatMessage(this.options.db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: `该会话只允许 ${names}；要交给 ${agent.name} 请先在运行设置里放行它。`,
      })
      throw new HubError('ACTION_REJECTED', `${agent.name} 不在该会话的可用 Agent 里`, {
        threadId: id,
      })
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
    const agent = this.pickScopedAgent(thread)
    if (agent === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    const waiting = this.waitingSubtask(thread)
    if (waiting !== undefined) {
      this.active.add(id)
      updateChatThread(this.options.db, threadId, { status: 'active' })
      void this.continueWaitingTask(
        threadId,
        waiting.taskId,
        String(thread.goalId ?? ''),
        waiting.subtaskId,
        answer,
        agent.name,
      )
      return getChatThread(this.options.db, threadId) ?? thread
    }
    this.start(threadId, answer, agent.name, userMessage, conversation)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  private waitingSubtask(thread: ChatThread): { taskId: string; subtaskId: string } | undefined {
    if (thread.taskId === undefined) return undefined
    const state = loadState(this.options.db)
    const task = state.tasks[thread.taskId]
    if (task === undefined || task.status !== 'waiting_input') return undefined
    const subtask = Object.values(state.subtasks).find(
      (item) => item.taskId === task.id && item.status === 'waiting_input',
    )
    return subtask === undefined ? undefined : { taskId: task.id, subtaskId: subtask.id }
  }

  /**
   * 澄清后的继续：沿用同一 Task/Subtask，只对等待中的子任务开新 attempt。
   * 不新建 Goal、不重新分解计划；能复用现场就复用，Agent session 结束属于已知边界。
   */
  private async continueWaitingTask(
    threadId: ChatThreadId,
    taskId: string,
    goalId: string,
    subtaskId: string,
    answer: string,
    agentName: string,
  ): Promise<void> {
    const db = this.options.db
    const sink = this.createEventSink(threadId, agentName)
    try {
      let state = loadState(db)
      const at = (): ReturnType<typeof asTimestamp> => asTimestamp(new Date().toISOString())
      state = appendEvent(db, state, {
        type: 'subtask.status',
        subtaskId: asSubtaskId(subtaskId),
        to: 'running',
        at: at(),
      }).state
      state = appendEvent(db, state, {
        type: 'task.status',
        taskId: asTaskId(taskId),
        to: 'running',
        at: at(),
      }).state
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'progress',
        stage: 'dispatching',
        content: `继续任务（沿用 task ${taskId.slice(-6)}，只重跑等待中的子任务）。`,
      })
      const subtask = state.subtasks[asSubtaskId(subtaskId)]
      const agent = resolveAgent(db, agentName)
      const result = await runAcpWithRetry({
        db,
        provider: this.options.provider,
        agent,
        goalId,
        taskId,
        subtaskId,
        objective: `${subtask?.description ?? ''}

用户补充：${answer}`,
        ...this.workspaceOf(threadId),
        checks: [{ kind: 'diffScope', allowedPaths: ['.'] }],
        clientVersion: this.options.clientVersion,
        onEvent: sink.onEvent,
      })
      if (result.ok) {
        completeTaskAfterDelivery(db, taskId, goalId)
      } else {
        failTask(db, { taskId, goalId, subtaskId })
      }
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: result.ok ? 'result' : 'error',
        content: result.ok
          ? '继续执行完成（沿用同一 task，未重新计划）。'
          : `继续执行没有通过（验收 ${verdictLabel(result.verdict)}），任务停在失败。`,
        taskId,
        goalId,
      })
      updateChatThread(db, threadId, {
        status: result.ok ? 'completed' : 'failed',
        taskId,
        goalId,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: `继续任务失败：${message}`,
      })
      failTask(db, { taskId, goalId, subtaskId })
      updateChatThread(db, threadId, { status: 'failed' })
    } finally {
      sink.flush()
      this.active.delete(threadId)
    }
  }

  /** 审批/澄清后继续；agentName 可换一个 Agent 重跑。 */
  async resume(id: string, agentName?: string): Promise<ChatThread> {
    const threadId = asChatThreadId(id)
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${id}`, { threadId: id })
    }
    if (this.active.has(id)) {
      throw new HubError('ACTION_REJECTED', 'thread already has an active run', { threadId: id })
    }
    const exact = this.exactResumeApproval(threadId)
    if (exact !== undefined) {
      this.active.add(id)
      try {
        return await this.finishExactResume(threadId, exact)
      } finally {
        this.active.delete(id)
      }
    }
    const messages = listChatMessages(this.options.db, threadId)
    const index = messages.findLastIndex((message) => message.role === 'user')
    const lastUser = index === -1 ? undefined : messages[index]
    if (lastUser === undefined) {
      throw new HubError('ACTION_REJECTED', 'thread has no user message', { threadId: id })
    }
    const agent = this.pickScopedAgent(thread, agentName)
    if (agent === undefined) {
      throw new HubError('NO_AGENT_AVAILABLE', '没有可用的 Agent', { threadId: id })
    }
    const conversation = this.turnsOf(messages.slice(0, index))
    this.start(threadId, lastUser.content, agent.name, lastUser, conversation)
    return getChatThread(this.options.db, threadId) ?? thread
  }

  /** 已批准、且执行还停在 waiting_permission：可以原地续跑，不必重开任务。 */
  private exactResumeApproval(threadId: ChatThreadId): Approval | undefined {
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined || thread.taskId === undefined) return undefined
    const state = loadState(this.options.db)
    return Object.values(state.approvals).find(
      (approval) =>
        approval.taskId === thread.taskId &&
        approval.status === 'approved' &&
        approval.executionId !== undefined &&
        state.executions[approval.executionId]?.status === 'waiting_permission',
    )
  }

  private async finishExactResume(threadId: ChatThreadId, approval: Approval): Promise<ChatThread> {
    const db = this.options.db
    updateChatThread(db, threadId, { status: 'active' })
    appendChatMessage(db, {
      threadId,
      role: 'assistant',
      kind: 'progress',
      stage: 'waiting',
      content: '审批已通过：续跑同一 execution 的验收（不重跑 Agent）。',
    })
    try {
      const outcome = await resumeExecution({
        db,
        provider: this.options.provider,
        approvalId: approval.id,
      })
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: outcome.ok ? 'result' : 'error',
        content: outcome.ok
          ? '验收通过，任务已完成（沿用同一 execution）。'
          : `验收仍未通过（${verdictLabel(outcome.verdict)}），任务停在失败；可以重新执行。`,
        taskId: outcome.taskId,
        goalId: outcome.goalId,
      })
      updateChatThread(db, threadId, {
        status: outcome.ok ? 'completed' : 'failed',
        taskId: outcome.taskId,
        goalId: outcome.goalId,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'error',
        content: `无法精确续跑：${message}`,
      })
      updateChatThread(db, threadId, { status: 'failed' })
    }
    return getChatThread(db, threadId) ?? (await this.requireThread(threadId))
  }

  private async requireThread(threadId: ChatThreadId): Promise<ChatThread> {
    const thread = getChatThread(this.options.db, threadId)
    if (thread === undefined) {
      throw new HubError('NOT_FOUND', `thread not found: ${threadId}`, { threadId })
    }
    return thread
  }

  private pickAgent(name?: string) {
    return name === undefined ? listAgents(this.options.db)[0] : resolveAgent(this.options.db, name)
  }

  /**
   * 在会话的可用 Agent 范围里挑一个（澄清应答 / 续跑用）。
   * 范围外的名字就当没有：与发送消息时的校验保持同一口径。
   */
  private pickScopedAgent(thread: ChatThread, name?: string) {
    const allowed = scopeAgents(listAgents(this.options.db), thread.runSettings)
    if (allowed.length === 0) return undefined
    if (name === undefined) return allowed[0]
    const picked = this.pickAgent(name)
    if (picked === undefined) return undefined
    return allowed.some((agent) => agent.name === picked.name) ? picked : undefined
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

  /**
   * Chat 首轮 Brain 的逐字输出。
   * - 模型按对话模式输出自然语言时，边写边更新同一条消息；
   * - 一旦开头像 JSON（模型没遵守协议），停止流式，等解析结果，避免把 JSON 喷到界面；
   * - 回合结束仍没有 reply（说明只是"我来处理"的前言）时，降级为 thinking 步骤。
   */
  private createBrainStream(threadId: ChatThreadId, analysisId: string) {
    const db = this.options.db
    let textId: string | undefined
    let text = ''
    let thought = ''
    let thoughtVisible = false
    let suppressed = false
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const flush = (): void => {
      clearTimer()
      try {
        if (thoughtVisible) {
          updateChatMessage(db, asChatMessageId(analysisId), {
            content: thought.slice(0, 4_000),
          })
        }
        if (textId !== undefined) {
          updateChatMessage(db, asChatMessageId(textId), { content: text.slice(0, 20_000) })
        }
      } catch {
        // 流式展示失败不影响回合结果。
      }
    }

    const schedule = (): void => {
      if (timer === undefined) timer = setTimeout(flush, 80)
    }

    const onDelta = (delta: BrainDelta): void => {
      if (done) return
      try {
        if (delta.kind === 'thinking') {
          /* 已经转成回答行后，迟到的思考不能覆盖正文。 */
          if (textId === analysisId) return
          thought += delta.text
          if (!thoughtVisible) {
            thoughtVisible = true
            updateChatMessage(db, asChatMessageId(analysisId), {
              stage: 'thought',
              content: thought.slice(0, 4_000),
            })
          } else {
            schedule()
          }
          return
        }
        text += delta.text
        if (suppressed) return
        if (textId === undefined) {
          if (/^\s*(\{|```)/.test(text.slice(0, 24))) {
            suppressed = true
            return
          }
          if (thoughtVisible) {
            const created = appendChatMessage(db, {
              threadId,
              role: 'assistant',
              kind: 'text',
              content: text,
            })
            textId = created.id
          } else {
            /* 还没有思考内容：复用“正在分析…”那一行，避免多出一条空步骤。 */
            textId = analysisId
            updateChatMessage(db, asChatMessageId(analysisId), {
              kind: 'text',
              stage: undefined,
              content: text,
            })
          }
        }
        schedule()
      } catch {
        // 同上
      }
    }

    const finish = (finalText: string | undefined): { streamed: boolean; messageId?: string } => {
      clearTimer()
      if (done) {
        return messageIdOf(textId)
      }
      done = true
      try {
        if (finalText !== undefined) {
          if (textId !== undefined) {
            updateChatMessage(db, asChatMessageId(textId), { content: finalText })
            return { streamed: true, messageId: textId }
          }
          if (!thoughtVisible) {
            updateChatMessage(db, asChatMessageId(analysisId), {
              kind: 'text',
              stage: undefined,
              content: finalText,
            })
            return { streamed: true, messageId: analysisId }
          }
          return { streamed: false }
        }
        if (textId !== undefined) {
          /* 有前言的回合最后转人工/审批：把前言收回 thinking，别当最终回答。 */
          updateChatMessage(db, asChatMessageId(textId), {
            kind: 'progress',
            stage: 'thinking',
            content: text.slice(0, 4_000),
          })
          return { streamed: true, messageId: textId }
        }
        if (!thoughtVisible) {
          updateChatMessage(db, asChatMessageId(analysisId), {
            stage: 'thinking',
            content: '已进入执行阶段，进度见下方步骤。',
          })
        }
      } catch {
        // ignore
      }
      return messageIdOf(textId)
    }

    const messageIdOf = (id: string | undefined): { streamed: boolean; messageId?: string } =>
      id === undefined ? { streamed: false } : { streamed: true, messageId: id }

    const dispose = (): void => {
      done = true
      clearTimer()
    }

    return { onDelta, finish, dispose }
  }

  /**
   * 把 ACP 的 session/update 折叠成可读的进度行：
   * 工具调用一条（原地更新状态），思考/输出各一条（最多 450ms 刷一次）。
   * 高频 delta 直接落库会写爆 SQLite，所以按时间片合并。
   */
  private createEventSink(threadId: ChatThreadId, agentName: string) {
    const db = this.options.db
    const tools = new Map<string, { messageId: string; title: string; detail?: string }>()
    let agentOutput = ''
    let outputFinalized = false
    let afterTool = false
    let thoughtId: string | undefined
    let thoughtText = ''
    let outputId: string | undefined
    let outputText = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const append = (stage: ChatProgressStage, text: string, detail?: string): string =>
      appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'progress',
        content: text,
        agentName,
        stage,
        ...(detail === undefined ? {} : { detail }),
      }).id

    const flush = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      try {
        if (thoughtId !== undefined) {
          updateChatMessage(db, asChatMessageId(thoughtId), {
            content: thoughtText.slice(0, 6_000),
          })
        }
        if (outputId !== undefined && !outputFinalized) {
          updateChatMessage(db, asChatMessageId(outputId), {
            content: outputText.slice(0, 6_000),
          })
        }
      } catch {
        // 过程展示失败不能影响任务执行。
      }
    }

    const schedule = (): void => {
      if (timer !== undefined) return
      timer = setTimeout(flush, 80)
    }

    const onEvent = (event: AcpExecutionEvent): void => {
      try {
        handle(event)
      } catch {
        // 同上：事件折叠是旁路，不能拖垮 ACP。
      }
    }

    const handle = (event: AcpExecutionEvent): void => {
      switch (event.kind) {
        case 'tool.call': {
          afterTool = true
          const title = event.title ?? toolLabel(event.raw)
          const detail = toolDetail(event.raw)
          const id = append(
            'tool',
            `${title}${event.status === undefined ? '' : ` · ${event.status}`}`,
            detail,
          )
          tools.set(event.toolCallId, {
            messageId: id,
            title,
            ...(detail === undefined ? {} : { detail }),
          })
          break
        }
        case 'tool.call.update': {
          afterTool = true
          const entry = tools.get(event.toolCallId)
          if (entry === undefined) break
          const title = event.title ?? entry.title
          const detail = mergeToolDetail(entry.detail, toolDetail(event.raw))
          tools.set(event.toolCallId, {
            messageId: entry.messageId,
            title,
            ...(detail === undefined ? {} : { detail }),
          })
          updateChatMessage(db, asChatMessageId(entry.messageId), {
            content: `${title}${event.status === undefined ? '' : ` · ${event.status}`}`,
            ...(detail === undefined ? {} : { detail }),
          })
          break
        }
        case 'message.delta': {
          if (event.role === 'thought') {
            if (thoughtId === undefined) {
              thoughtText = event.text
              thoughtId = append('thought', thoughtText)
            } else {
              thoughtText += event.text
              schedule()
            }
          } else if (event.role === 'agent') {
            if (afterTool && agentOutput !== '') agentOutput += '\n\n'
            afterTool = false
            agentOutput += event.text
            if (outputId === undefined) {
              outputText = event.text
              outputId = append('output', outputText)
            } else {
              outputText += event.text
              schedule()
            }
          }
          break
        }
        case 'process.exit': {
          append(
            'failed',
            `ACP 进程退出（${event.reason}${event.code === null ? '' : ` · code ${event.code}`}）`,
          )
          break
        }
        case 'plan.updated': {
          const text = event.entries
            .map((entry) => entry.content)
            .join(' / ')
            .slice(0, 240)
          if (text !== '') append('planned', `计划：${text}`)
          break
        }
        default:
          break
      }
    }

    /** 成功的任务把 Agent 的最终输出当作回答，而不是只报一个任务编号。 */
    const finalizeOutput = (): { id: string; text: string } | undefined => {
      outputFinalized = true
      const text = agentOutput.trim()
      return outputId === undefined || text === '' ? undefined : { id: outputId, text }
    }

    return { onEvent, flush, finalizeOutput }
  }

  private async run(
    threadId: ChatThreadId,
    objective: string,
    agentName: string,
    userMessage: ChatMessage,
    conversation: ChatTurn[],
  ): Promise<void> {
    const db = this.options.db
    let sink: ReturnType<ChatService['createEventSink']> | undefined
    let brainStream: ReturnType<ChatService['createBrainStream']> | undefined
    let stderrTail: string[] = []
    try {
      const agent = resolveAgent(db, agentName)
      const agents = listAgents(db)
      /* 会话级运行设置：验收命令 / 可用 Agent / 预算（ADR 0029 §2.4）。 */
      const settings = getChatThread(db, threadId)?.runSettings ?? DEFAULT_RUN_SETTINGS
      const scoped = scopeAgents(agents, settings)
      const budget = brainBudget(settings)
      const sink = this.createEventSink(threadId, agentName)
      const analysis = appendChatMessage(db, {
        threadId,
        role: 'assistant',
        kind: 'progress',
        stage: 'thinking',
        content: '正在分析你的请求…',
      })
      brainStream = this.createBrainStream(threadId, analysis.id)
      const result = await runGoalWithBrain({
        db,
        provider: this.options.provider,
        brain: this.options.brain,
        agent,
        availableAgents: scoped,
        objective,
        conversation,
        onBrainDelta: brainStream.onDelta,
        ...this.workspaceOf(threadId),
        checks: verificationChecks(settings),
        ...(budget === undefined ? {} : { budget }),
        clientVersion: this.options.clientVersion,
        completeOnSuccess: true,
        ...(this.options.remote === undefined ? {} : { remote: this.options.remote }),
        onProgress: (step) => {
          appendChatMessage(db, {
            threadId,
            role: 'assistant',
            kind: 'progress',
            content: step.text,
            stage: step.stage,
            ...(step.agent === undefined ? {} : { agentName: step.agent }),
          })
        },
        onEvent: sink.onEvent,
        onStderr: (line) => {
          if (line.trim() === '') return
          stderrTail = [...stderrTail.slice(-14), line]
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
      /* 任务成功时，最终回答用 Agent 自己的输出，而不是 Brain 的“任务完成/编号”总结。 */
      const produced = result.ok ? sink.finalizeOutput() : undefined
      const segments =
        result.ok && result.goalId !== undefined
          ? collectAgentOutputs(
              loadState(db),
              result.goalId,
              new Map(listAgents(db).map((agent) => [String(agent.id), agent.name])),
            )
          : []
      /* 已产出“回答”？分段列表与流式文本任一有内容都算，避免后面再多补一条“任务完成”。 */
      const answered = produced !== undefined || segments.length > 0
      if (answered) {
        brainStream?.finish(undefined)
        if (produced !== undefined) {
          /* 流式输出行收成一句提示，完整结果追加到回合末尾（保证是最后一条回答）。 */
          updateChatMessage(db, asChatMessageId(produced.id), {
            kind: 'progress',
            stage: 'output',
            content: 'Agent 输出已生成，完整内容见下方回答。',
          })
        }
        if (segments.length > 0) {
          /*
           * 每个子任务单独成段：一次对话可能派给多个 Agent（workbuddy + dsh），
           * 以前它们的输出会累加到同一个字符串里、无归属、并且 20k 以后被静默砍掉。
           */
          for (const segment of segments) {
            appendChatMessage(db, {
              threadId,
              role: 'assistant',
              kind: 'text',
              content:
                segment.title === undefined
                  ? segment.text
                  : `**${segment.title}**\n\n${segment.text}`,
              agentName: segment.agentName,
              ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
              ...(segment.taskId === undefined ? {} : { taskId: segment.taskId }),
            })
          }
        } else if (produced !== undefined) {
          /* 拿不到证据（例如全是远程执行）时退回流式文本，宁可少归属也别丢内容。 */
          appendChatMessage(db, {
            threadId,
            role: 'assistant',
            kind: 'text',
            content: produced.text.slice(0, 20_000),
            ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          })
        }
      }
      /* 有卡/无 reply 时，流式文本只是前言：收起成 thinking 步骤。 */
      if (
        !answered &&
        (result.reply === undefined ||
          result.approval !== undefined ||
          result.clarification !== undefined)
      ) {
        brainStream?.finish(undefined)
      }
      if (answered) {
        /* 已用 Agent 输出作为回答，跳过 Brain 总结与“任务完成”卡片。 */
      } else if (result.approval !== undefined) {
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
        const streamed = brainStream?.finish(result.reply) ?? { streamed: false }
        if (!streamed.streamed) {
          appendChatMessage(db, {
            threadId,
            role: 'assistant',
            kind: 'text',
            content: result.reply,
            ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          })
        }
      } else {
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: result.ok ? 'result' : 'error',
          content: result.ok
            ? `任务已完成（验收通过）。详情见任务 ${result.taskId ?? ''}`
            : `任务没有完成（验收 ${verdictLabel(result.verdict)}）${result.taskId === undefined ? '' : `，任务 ${result.taskId} 还留着现场`}。`,
          ...(thread?.goalId === undefined ? {} : { goalId: thread.goalId }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        })
      }
    } catch (cause) {
      brainStream?.finish(undefined)
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
        const detail = stderrTail.length === 0 ? '' : `\n\n${stderrTail.join('\n')}`
        const sandboxIssue = stderrTail.some((line) =>
          /sandbox_apply|Operation not permitted/i.test(line),
        )
        appendChatMessage(db, {
          threadId,
          role: 'assistant',
          kind: 'error',
          content: `${message}${detail}${
            sandboxIssue
              ? '\n\n提示：沙箱无法应用，HubAgent 很可能本身运行在另一个沙箱里（例如从 DSH 终端启动）。请从系统终端重启 pnpm ha web。'
              : ''
          }`,
        })
      }
    } finally {
      sink?.flush()
      brainStream?.dispose()
      this.active.delete(userMessage.threadId)
    }
  }
}

export function createChatService(options: ChatServiceOptions): ChatService {
  return new ChatService(options)
}
