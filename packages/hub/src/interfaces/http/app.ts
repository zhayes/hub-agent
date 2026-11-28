import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  pickDirectory as nativePickDirectory,
  type PickDirectoryOutcome,
} from '../../agent-host/native-picker'
import { isDeliveryMode, normalizeRunSettings } from '../../domain/chat'
import { asChatThreadId } from '../../domain/ids'
import { isPermissionMode } from '../../domain/status'
import { acceptExecution, rejectExecution } from '../../runtime/acceptance'
import { adoptAgent, loginAgent, verifyAgent } from '../../runtime/agent-adopt'
import { scanAgents } from '../../runtime/agent-discovery/scan'
import { listAgents, removeAgent, setAgentStatus } from '../../runtime/agent-registry'
import { decideApproval, listApprovals } from '../../runtime/approval'
import type { ChatService } from '../../runtime/chat/chat-service'
import { getClarification } from '../../runtime/clarify'
import { listDecisions } from '../../runtime/decision-record'
import {
  deleteProvider,
  listProviders,
  parseModelPatch,
  readModelConfig,
  writeModelConfig,
} from '../../runtime/model-config/model-config'
import { readTaskFile } from '../../runtime/task-files'
import { deliverTask } from '../../runtime/workspace/deliver'
import type { SandboxProvider } from '../../sandbox/types'
import { type ErrorCode, HubError } from '../../shared/errors'
import { hubDir, resolvePiAgentDir } from '../../shared/paths'
import type { Db } from '../../storage/db'
import { listAgentPresence } from '../../storage/queries/agent-presence'
import {
  getChatThread,
  listChatMessagesAfter,
  listChatMessagesUpdatedAfter,
  maxChatUpdatedAt,
} from '../../storage/queries/chat'
import { listEventsSince } from '../../storage/queries/events'
import { getTaskEvidence } from '../../storage/queries/evidence'
import { listTasks } from '../../storage/queries/tasks'

export interface HttpAppOptions {
  db: Db
  token: string
  version?: string
  /** 构建后的 Web Console 目录；不传则不托管静态资源 */
  webDist?: string
  /** Chat 需要 provider；测试可注入 fake，未注入时端点 501 */
  chat?: ChatService
  /** Pi profile 目录（models.json / settings.json）；缺省见 resolvePiAgentDir */
  modelDir?: string
  /** 接入/验证需要起进程；缺省时相关端点返回 501 */
  provider?: SandboxProvider
  /** 探测用的运行目录；缺省取 HUBAGENT_HOME */
  home?: string
  /**
   * 系统目录选择框；缺省用原生实现（macOS）。测试注入假实现以便不起 GUI。
   * 注意：它**不接受路径参数**，只能返回用户在系统框里选的目录。
   */
  pickDirectory?: (options?: { prompt?: string }) => Promise<PickDirectoryOutcome>
}

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono()
  const { db, token } = options
  const modelDir = options.modelDir ?? resolvePiAgentDir()

  app.use('/api/v1/*', async (context, next) => {
    const header = context.req.header('authorization') ?? ''
    const queryToken = context.req.query('token')
    if (header !== `Bearer ${token}` && queryToken !== token) {
      return context.json({ code: 'UNAUTHORIZED', message: 'invalid bearer token' }, 401)
    }
    await next()
  })

  app.get('/api/v1/health', (context) =>
    context.json({ ok: true, version: options.version ?? '0.0.0' }),
  )

  /* 模型设置就是 Pi profile 的 models.json / settings.json；永远不回传明文 key。 */
  app.get('/api/v1/settings/model', (context) => {
    try {
      return context.json({
        ok: true,
        model: readModelConfig(modelDir),
        providers: listProviders(modelDir),
      })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.put('/api/v1/settings/model', async (context) => {
    const body = await context.req.json<unknown>().catch((): unknown => undefined)
    try {
      const model = writeModelConfig(modelDir, parseModelPatch(body))
      return context.json({ ok: true, model, providers: listProviders(modelDir) })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.delete('/api/v1/settings/model/providers/:providerId', (context) => {
    try {
      const providers = deleteProvider(modelDir, context.req.param('providerId'))
      return context.json({ ok: true, model: readModelConfig(modelDir), providers })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.get('/api/v1/tasks', (context) => {
    const limit = Number.parseInt(context.req.query('limit') ?? '50', 10)
    return context.json({ ok: true, tasks: listTasks(db, Number.isFinite(limit) ? limit : 50) })
  })

  app.get('/api/v1/tasks/:id/file', (context) => {
    const path = context.req.query('path')
    if (path === undefined || path === '') {
      return context.json({ code: 'ACTION_REJECTED', message: '缺少 path' }, 400)
    }
    try {
      return context.json({ ok: true, file: readTaskFile(db, context.req.param('id'), path) })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.get('/api/v1/tasks/:id', (context) => {
    const view = getTaskEvidence(db, context.req.param('id'))
    return view === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'task not found' }, 404)
      : context.json({ ok: true, ...view })
  })

  app.get('/api/v1/tasks/:id/evidence', (context) => {
    const view = getTaskEvidence(db, context.req.param('id'))
    return view === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'task not found' }, 404)
      : context.json({
          ok: true,
          task: view.task,
          executions: view.executions,
          verifications: view.verifications,
        })
  })

  app.get('/api/v1/tasks/:id/plan', (context) => {
    const view = getTaskEvidence(db, context.req.param('id'))
    return view === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'task not found' }, 404)
      : context.json({ ok: true, task: view.task, subtasks: view.subtasks })
  })

  app.get('/api/v1/tasks/:id/decisions', (context) => {
    const view = getTaskEvidence(db, context.req.param('id'))
    return view === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'task not found' }, 404)
      : context.json({ ok: true, decisions: listDecisions(db, view.task.goalId) })
  })

  /**
   * 交付（PRD §6.12.4）：用户显式选一次交付方式。
   *
   * 只有两种：branch-only 保留分支、patch-export 导出补丁。
   * 合并进主干是人的动作，不提供 auto-merge（ADR 0031）。
   */
  app.post('/api/v1/tasks/:id/deliver', async (context) => {
    const body = await context.req.json<{ mode?: unknown }>().catch((): { mode?: unknown } => ({}))
    const mode = body.mode ?? 'branch-only'
    if (!isDeliveryMode(mode)) {
      return context.json(
        {
          code: 'INVALID_INPUT',
          message: '交付方式只能是 branch-only / patch-export',
        },
        400,
      )
    }
    try {
      return context.json({ ok: true, delivery: deliverTask(db, context.req.param('id'), mode) })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  /* 澄清卡片要 options 才能渲染成按钮：答案必须精确命中选项，手打文本会被拒。 */
  app.get('/api/v1/clarifications/:id', (context) => {
    const clarification = getClarification(db, context.req.param('id'))
    return clarification === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'clarification not found' }, 404)
      : context.json({ ok: true, clarification })
  })

  app.post('/api/v1/chat/threads', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req
      .json<{
        title?: string
        worktree?: string
        permissionMode?: string
        runSettings?: unknown
      }>()
      .catch(
        (): {
          title?: string
          worktree?: string
          permissionMode?: string
          runSettings?: unknown
        } => ({}),
      )
    /* 产品规则：新建对话必须选工作区。不选就不给它一个“默认到 cwd”的机会。 */
    if (body.worktree === undefined || body.worktree.trim() === '') {
      return context.json(
        { code: 'INVALID_INPUT', message: '新建对话必须选择工作区（worktree）' },
        400,
      )
    }
    try {
      const thread = options.chat.createThread({
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.worktree === undefined ? {} : { worktree: body.worktree }),
        ...(isPermissionMode(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
        ...(body.runSettings === undefined
          ? {}
          : { runSettings: normalizeRunSettings(body.runSettings) }),
      })
      return context.json({ ok: true, thread }, 201)
    } catch (error) {
      return context.json(
        {
          code: 'THREAD_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      )
    }
  })

  /**
   * 弹系统目录选择框（新增会话选工作区）。
   *
   * 刻意**不收任何路径参数**：它只能返回用户在系统框里亲手选的目录，
   * 因此不可能被用来探测服务器上的任意目录。
   */
  app.post('/api/v1/fs/pick-directory', async (context) => {
    const picker =
      options.pickDirectory ??
      ((pickerOptions?: { prompt?: string }) => nativePickDirectory(pickerOptions))
    const outcome = await picker({ prompt: '选择这个对话的工作区' })
    switch (outcome.kind) {
      case 'picked':
        return context.json({ ok: true, path: outcome.path })
      case 'cancelled':
        return context.json({ ok: true, cancelled: true })
      case 'busy':
        return context.json({ code: 'PICKER_BUSY', message: '已有一个选择框在等待用户操作' }, 409)
      case 'unsupported':
        return context.json(
          {
            code: 'UNSUPPORTED_PLATFORM',
            message: '当前平台没有系统目录选择框，请手动填写路径',
          },
          501,
        )
    }
  })

  app.get('/api/v1/chat/threads', (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const limit = Number.parseInt(context.req.query('limit') ?? '50', 10)
    return context.json({
      ok: true,
      threads: options.chat.listThreads(Number.isFinite(limit) ? limit : 50),
    })
  })

  app.get('/api/v1/chat/threads/:id', (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const limit = Number.parseInt(context.req.query('limit') ?? '100', 10)
    const before = context.req.query('before')
    const value = options.chat.getThread(context.req.param('id'), {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(before === undefined ? {} : { before }),
    })
    return value === undefined
      ? context.json({ code: 'NOT_FOUND', message: 'thread not found' }, 404)
      : context.json({ ok: true, ...value })
  })

  app.patch('/api/v1/chat/threads/:id', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req
      .json<{
        title?: unknown
        archived?: unknown
        permissionMode?: unknown
        worktree?: unknown
        runSettings?: unknown
      }>()
      .catch(
        (): {
          title?: unknown
          archived?: unknown
          permissionMode?: unknown
          worktree?: unknown
          runSettings?: unknown
        } => ({}),
      )
    try {
      let thread = options.chat.getThread(context.req.param('id'))?.thread
      if (thread === undefined) {
        return context.json({ code: 'NOT_FOUND', message: 'thread not found' }, 404)
      }
      if (typeof body.title === 'string') {
        thread = options.chat.renameThread(context.req.param('id'), body.title)
      }
      if (body.archived === true) {
        thread = options.chat.archiveThread(context.req.param('id'))
      }
      /* 切换权限档 / 补齐工作区（旧会话）。都只影响后续回合。 */
      if (isPermissionMode(body.permissionMode)) {
        thread = options.chat.setPermissionMode(context.req.param('id'), body.permissionMode)
      }
      if (typeof body.worktree === 'string' && body.worktree.trim() !== '') {
        thread = options.chat.setWorkspace(context.req.param('id'), body.worktree)
      }
      /* 运行设置（验收命令 / 可用 Agent / 预算）只影响后续回合。 */
      if (body.runSettings !== undefined) {
        thread = options.chat.setRunSettings(
          context.req.param('id'),
          normalizeRunSettings(body.runSettings),
        )
      }
      return context.json({ ok: true, thread })
    } catch (error) {
      return context.json(
        {
          code: 'CHAT_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.delete('/api/v1/chat/threads/:id', (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    try {
      options.chat.deleteThread(context.req.param('id'))
      return context.json({ ok: true })
    } catch (error) {
      return context.json(
        {
          code: 'CHAT_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  /* 消息增量推送：客户端不再轮询整页。游标形如 `<createdAt>~<messageId>`。 */
  app.get('/api/v1/chat/threads/:id/stream', (context) => {
    const threadId = asChatThreadId(context.req.param('id'))
    if (getChatThread(db, threadId) === undefined) {
      return context.json({ code: 'NOT_FOUND', message: 'thread not found' }, 404)
    }
    const raw = context.req.header('last-event-id') ?? context.req.query('after') ?? ''
    const parsed = Number.parseInt(raw, 10)
    let cursor = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        let closed = false
        let lastStatus = ''
        let updateCursor = ''
        const send = (event: string, data: unknown, id?: number) => {
          const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          controller.enqueue(encoder.encode(frame))
        }
        /* Drain the backlog before reporting the thread status, so a finished
           thread still delivers its final messages before the stream closes. */
        const flush = (): void => {
          for (;;) {
            const batch = listChatMessagesAfter(db, threadId, cursor, 100)
            for (const entry of batch) {
              send('message', entry.message, entry.seq)
              cursor = entry.seq
              const stamp = entry.message.updatedAt
              if (stamp !== undefined && stamp > updateCursor) updateCursor = stamp
            }
            if (batch.length < 100) return
          }
        }
        const close = () => {
          if (closed) return
          closed = true
          clearInterval(timer)
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
        const tick = () => {
          if (closed) return
          /* 首帧前把所有已存在的消息当成“已读”，只推之后的原地更新。 */
          if (updateCursor === '') updateCursor = maxChatUpdatedAt(db, threadId) ?? ''
          flush()
          if (updateCursor !== '') {
            for (const message of listChatMessagesUpdatedAfter(db, threadId, updateCursor, 100)) {
              const stamp = message.updatedAt
              if (stamp !== undefined) updateCursor = stamp > updateCursor ? stamp : updateCursor
              send('message.update', message)
            }
          }
          const thread = getChatThread(db, threadId)
          if (thread === undefined) return close()
          if (thread.status !== lastStatus) {
            lastStatus = thread.status
            send('status', { status: thread.status })
          }
          if (thread.status !== 'active') close()
        }
        const timer = setInterval(tick, 400)
        tick()
        context.req.raw.signal.addEventListener('abort', close, { once: true })
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  })

  app.post('/api/v1/chat/threads/:id/messages', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req
      .json<{ text?: string; agentName?: string }>()
      .catch((): { text?: string; agentName?: string } => ({}))
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return context.json({ code: 'INVALID_INPUT', message: 'text is required' }, 400)
    }
    try {
      const thread = await options.chat.postMessage(context.req.param('id'), {
        text: body.text,
        ...(body.agentName === undefined ? {} : { agentName: body.agentName }),
      })
      return context.json(
        { ok: true, thread, messages: options.chat.getThread(thread.id)?.messages ?? [] },
        202,
      )
    } catch (error) {
      return context.json(
        {
          code: 'CHAT_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.post('/api/v1/chat/threads/:id/resume', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req
      .json<{ agentName?: unknown }>()
      .catch((): { agentName?: unknown } => ({}))
    try {
      const thread = await options.chat.resume(
        context.req.param('id'),
        typeof body.agentName === 'string' && body.agentName !== '' ? body.agentName : undefined,
      )
      return context.json(
        { ok: true, thread, messages: options.chat.getThread(thread.id)?.messages ?? [] },
        202,
      )
    } catch (error) {
      return context.json(
        {
          code: 'CHAT_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.post('/api/v1/chat/threads/:id/clarifications/:clarificationId/answer', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req
      .json<{ answer?: string }>()
      .catch((): { answer?: string } => ({}))
    if (typeof body.answer !== 'string' || body.answer.trim().length === 0) {
      return context.json({ code: 'INVALID_INPUT', message: 'answer is required' }, 400)
    }
    try {
      const thread = await options.chat.answer(
        context.req.param('id'),
        context.req.param('clarificationId'),
        body.answer,
      )
      return context.json(
        { ok: true, thread, messages: options.chat.getThread(thread.id)?.messages ?? [] },
        202,
      )
    } catch (error) {
      return context.json(
        {
          code: 'CHAT_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.post('/api/v1/agents/adopt', async (context) => {
    if (options.provider === undefined) {
      return context.json({ code: 'SANDBOX_UNAVAILABLE', message: '接入需要沙箱 provider' }, 501)
    }
    const body = await context.req.json<unknown>().catch((): unknown => undefined)
    if (typeof body !== 'object' || body === null) {
      return context.json({ code: 'CONFIG_INVALID', message: '需要 JSON 请求体' }, 400)
    }
    const record = body as { catalogId?: unknown; variantId?: unknown }
    if (typeof record.catalogId !== 'string' || record.catalogId.length === 0) {
      return context.json({ code: 'CONFIG_INVALID', message: '缺少 catalogId' }, 400)
    }
    try {
      const result = await adoptAgent({
        db,
        provider: options.provider,
        home: options.home ?? hubDir(),
        catalogId: record.catalogId,
        ...(typeof record.variantId === 'string' ? { variantId: record.variantId } : {}),
      })
      return context.json({ ok: result.probe.ok, agent: result.agent, probe: result.probe })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.post('/api/v1/agents/:name/authenticate', async (context) => {
    if (options.provider === undefined) {
      return context.json({ code: 'SANDBOX_UNAVAILABLE', message: '登录需要沙箱 provider' }, 501)
    }
    const body = await context.req.json<unknown>().catch((): unknown => undefined)
    const methodId =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { methodId?: unknown }).methodId === 'string'
        ? (body as { methodId: string }).methodId
        : undefined
    if (methodId === undefined || methodId.length === 0) {
      return context.json({ code: 'CONFIG_INVALID', message: '缺少 methodId' }, 400)
    }
    try {
      const result = await loginAgent({
        db,
        provider: options.provider,
        home: options.home ?? hubDir(),
        name: context.req.param('name'),
        methodId,
      })
      return context.json({ ok: result.ok, result })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.post('/api/v1/agents/:name/verify', async (context) => {
    if (options.provider === undefined) {
      return context.json({ code: 'SANDBOX_UNAVAILABLE', message: '验证需要沙箱 provider' }, 501)
    }
    try {
      const result = await verifyAgent({
        db,
        provider: options.provider,
        home: options.home ?? hubDir(),
        name: context.req.param('name'),
      })
      return context.json({ ok: result.probe.ok, agent: result.agent, probe: result.probe })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  app.get('/api/v1/agents', (context) => context.json({ ok: true, agents: listAgents(db) }))

  /* 扫描本机可接入的 Agent（只读文件系统，不启动进程）。 */
  app.post('/api/v1/agents/scan', (context) => {
    try {
      return context.json({ ok: true, ...scanAgents(db) })
    } catch (error) {
      return errorResponse(context, error)
    }
  })

  /* Agent Office 舞台的只读 presence（PLAN-AGENT-OFFICE §3.1）；不写库。 */
  app.get('/api/v1/agents/presence', (context) =>
    context.json({ ok: true, ...listAgentPresence(db) }),
  )

  app.delete('/api/v1/agents/:name', (context) => {
    const name = context.req.param('name')
    if (!removeAgent(db, name)) {
      return context.json({ code: 'NOT_FOUND', message: `没有名为 ${name} 的 Agent` }, 404)
    }
    return context.json({ ok: true })
  })

  app.patch('/api/v1/agents/:name', async (context) => {
    const name = context.req.param('name')
    const body = await context.req.json<unknown>().catch((): unknown => undefined)
    const status =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { status?: unknown }).status === 'string'
        ? (body as { status: string }).status
        : undefined
    if (status === undefined || !['disabled', 'discovered'].includes(status)) {
      return context.json(
        { code: 'CONFIG_INVALID', message: 'status 只支持 disabled / discovered' },
        400,
      )
    }
    const agent = setAgentStatus(db, name, status)
    if (agent === undefined) {
      return context.json({ code: 'NOT_FOUND', message: `没有名为 ${name} 的 Agent` }, 404)
    }
    return context.json({ ok: true, agent })
  })

  app.get('/api/v1/approvals', (context) =>
    context.json({ ok: true, approvals: listApprovals(db) }),
  )

  for (const [action, status] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(`/api/v1/approvals/:id/${action}`, (context) => {
      try {
        const state = decideApproval(db, context.req.param('id'), status)
        return context.json({ ok: true, approval: state.approvals[context.req.param('id')] })
      } catch (error) {
        return context.json(
          {
            code: 'APPROVAL_REJECTED',
            message: error instanceof Error ? error.message : String(error),
          },
          409,
        )
      }
    })
  }

  /* 人工验收：把停在 waiting_input 的执行接受或拒绝（PRD §7.7）。 */
  app.post('/api/v1/executions/:id/accept', async (context) => {
    const note = await optionalText(
      context.req.json<unknown>().catch(() => undefined),
      ['note', 'reason'],
    )
    try {
      const result = acceptExecution(db, {
        executionId: context.req.param('id'),
        ...(note === undefined ? {} : { note }),
      })
      return context.json({ ok: true, ...result })
    } catch (error) {
      return context.json(
        {
          code: 'ACCEPTANCE_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.post('/api/v1/executions/:id/reject', async (context) => {
    const reason =
      (await optionalText(
        context.req.json<unknown>().catch(() => undefined),
        ['reason', 'note'],
      )) ?? 'rejected by human'
    try {
      const result = rejectExecution(db, {
        executionId: context.req.param('id'),
        reason,
      })
      return context.json({ ok: true, ...result })
    } catch (error) {
      return context.json(
        {
          code: 'ACCEPTANCE_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
        409,
      )
    }
  })

  app.get('/api/v1/events/stream', (context) => {
    const since = Number.parseInt(context.req.query('sinceSeq') ?? '0', 10)
    let seq = Number.isFinite(since) ? since : 0
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        let closed = false
        const send = (event: ReturnType<typeof listEventsSince>[number]) => {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\nevent: hubagent\ndata: ${JSON.stringify(event)}\n\n`),
          )
        }
        const tick = () => {
          if (closed) return
          for (const event of listEventsSince(db, seq, 100)) {
            seq = event.seq
            send(event)
          }
        }
        const timer = setInterval(tick, 1000)
        tick()
        const close = () => {
          if (closed) return
          closed = true
          clearInterval(timer)
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
        context.req.raw.signal.addEventListener('abort', close, { once: true })
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  })

  if (options.webDist !== undefined) {
    const root = resolve(options.webDist)
    app.get('/*', (context) => {
      const requestPath = normalize(decodeURIComponent(context.req.path))
      if (requestPath.startsWith('/api/')) {
        return context.json({ code: 'NOT_FOUND', message: 'not found' }, 404)
      }
      const file = resolve(join(root, requestPath === '/' ? 'index.html' : requestPath))
      if (!file.startsWith(root)) return context.text('forbidden', 403)
      const index = join(root, 'index.html')
      if (!existsSync(index)) return context.text('web console not built', 404)
      const target = existsSync(file) && statSync(file).isFile() ? file : index
      const body = readFileSync(target)
      if (target.endsWith('.html')) {
        const html = body
          .toString('utf8')
          .replace(
            '</head>',
            `<script>window.__HUBAGENT_TOKEN__ = ${JSON.stringify(token)}</script></head>`,
          )
        /* 入口 HTML 绝不能被缓存：重新构建后文件名变了，旧 HTML 会去拉已经不存在的
           asset，页面就停在旧版本或直接白屏。 */
        return context.body(html, 200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
      }
      return context.body(body, 200, {
        'content-type': contentType(target),
        'cache-control': 'no-cache',
      })
    })
  }

  return app
}

/** 错误码 → HTTP 状态。没有登记的按 500 处理。 */
const ERROR_STATUS: Partial<Record<ErrorCode, 400 | 404 | 500>> = {
  CONFIG_INVALID: 400,
  NOT_FOUND: 404,
}

/** 只向客户端暴露稳定错误码，不泄漏底层异常。 */
function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof HubError) {
    return context.json(
      { code: error.code, message: error.message },
      ERROR_STATUS[error.code] ?? 500,
    )
  }
  return context.json(
    { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) },
    500,
  )
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}

/** 从请求体里取第一个非空字符串字段（人工接受/拒绝的说明是可选的）。 */
async function optionalText(body: unknown, keys: readonly string[]): Promise<string | undefined> {
  const resolved = await body
  if (typeof resolved !== 'object' || resolved === null) return undefined
  const record = resolved as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}
