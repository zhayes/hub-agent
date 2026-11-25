import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { asChatThreadId } from '../../domain/ids'
import { listAgents } from '../../runtime/agent-registry'
import { decideApproval, listApprovals } from '../../runtime/approval'
import type { ChatService } from '../../runtime/chat/chat-service'
import { listDecisions } from '../../runtime/decision-record'
import {
  deleteProvider,
  listProviders,
  parseModelPatch,
  readModelConfig,
  writeModelConfig,
} from '../../runtime/model-config/model-config'
import { type ErrorCode, HubError } from '../../shared/errors'
import { resolvePiAgentDir } from '../../shared/paths'
import type { Db } from '../../storage/db'
import { listAgentPresence } from '../../storage/queries/agent-presence'
import { getChatThread, listChatMessagesAfter } from '../../storage/queries/chat'
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

  app.post('/api/v1/chat/threads', async (context) => {
    if (options.chat === undefined) return context.json({ code: 'NOT_IMPLEMENTED' }, 501)
    const body = await context.req.json<{ title?: string }>().catch((): { title?: string } => ({}))
    const thread = options.chat.createThread({
      ...(body.title === undefined ? {} : { title: body.title }),
    })
    return context.json({ ok: true, thread }, 201)
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
          flush()
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
      .json<{ text?: string; mode?: 'run' | 'ask'; agentName?: string }>()
      .catch((): { text?: string; mode?: 'run' | 'ask'; agentName?: string } => ({}))
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return context.json({ code: 'INVALID_INPUT', message: 'text is required' }, 400)
    }
    try {
      const thread = await options.chat.postMessage(context.req.param('id'), {
        text: body.text,
        ...(body.mode === 'run' || body.mode === 'ask' ? { mode: body.mode } : {}),
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
    try {
      const thread = await options.chat.resume(context.req.param('id'))
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

  app.get('/api/v1/agents', (context) => context.json({ ok: true, agents: listAgents(db) }))

  /* Agent Office 舞台的只读 presence（PLAN-AGENT-OFFICE §3.1）；不写库。 */
  app.get('/api/v1/agents/presence', (context) =>
    context.json({ ok: true, ...listAgentPresence(db) }),
  )

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
        return context.html(html)
      }
      return context.body(body, 200, { 'content-type': contentType(target) })
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
