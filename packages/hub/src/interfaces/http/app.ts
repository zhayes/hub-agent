import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { Hono } from 'hono'
import { listAgents } from '../../runtime/agent-registry'
import { decideApproval, listApprovals } from '../../runtime/approval'
import { listDecisions } from '../../runtime/decision-record'
import type { Db } from '../../storage/db'
import { listEventsSince } from '../../storage/queries/events'
import { getTaskEvidence } from '../../storage/queries/evidence'
import { listTasks } from '../../storage/queries/tasks'

export interface HttpAppOptions {
  db: Db
  token: string
  version?: string
  /** 构建后的 Web Console 目录；不传则不托管静态资源 */
  webDist?: string
}

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono()
  const { db, token } = options

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

  app.get('/api/v1/agents', (context) => context.json({ ok: true, agents: listAgents(db) }))

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
