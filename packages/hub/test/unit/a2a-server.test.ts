import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Role, TaskState, taskStateToJSON } from '@a2a-js/sdk'
import { DefaultRequestHandler } from '@a2a-js/sdk/server'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAgentCard } from '../../src/adapters/a2a/card'
import { createSqliteTaskStore } from '../../src/adapters/a2a/task-store'
import { createA2aApp } from '../../src/interfaces/a2a/routes'
import { createA2aExecutor, type InboundTaskRunner } from '../../src/runtime/a2a-executor'
import { bearerOf, registerPeer, revokePeer, verifyPeerToken } from '../../src/runtime/a2a-peers'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function freshFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-a2a-'))
  dirs.push(dir)
  return join(dir, 'state.db')
}

function open(path: string): Db {
  const db = openDatabase(path)
  migrate(db)
  dbs.push(db)
  return db
}

function runner(outcome: Awaited<ReturnType<InboundTaskRunner['run']>>): InboundTaskRunner {
  return {
    run: async () => outcome,
    cancel: async () => ({ contextId: 'ctx-from-runner' }),
  }
}

function serverApp(db: Db, taskRunner: InboundTaskRunner) {
  const card = buildAgentCard({
    name: 'hub-b',
    description: '被委托方',
    version: '0.0.0-test',
    url: 'https://127.0.0.1:0/a2a',
    streaming: true,
  })
  const handler = new DefaultRequestHandler(
    card,
    createSqliteTaskStore(db),
    createA2aExecutor(taskRunner),
  )
  return createA2aApp({
    handler,
    agentCard: card,
    identify: ({ authorization }) => {
      const token = bearerOf(authorization)
      return token === undefined ? undefined : verifyPeerToken(db, token)
    },
  })
}

function sendParams(text: string) {
  return {
    tenant: '',
    message: {
      messageId: `m-${text}`,
      role: Role.ROLE_USER,
      contextId: '',
      taskId: '',
      parts: [
        {
          content: { $case: 'text' as const, value: text },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
      ],
      extensions: [],
      referenceTaskIds: [],
      metadata: {},
    },
    configuration: undefined,
    metadata: {},
  }
}

function post(
  app: ReturnType<typeof serverApp>,
  body: unknown,
  options: { token?: string; version?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.version !== undefined) headers['a2a-version'] = options.version
  return app.request('/a2a', { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('A2A Server：JSON-RPC 入站面', () => {
  it('认证通过后完成一次委托，并把 Task 落到投影表', async () => {
    const db = open(freshFile())
    const { token } = registerPeer(db, { displayName: 'peer-a' })
    const app = serverApp(db, runner({ state: 'completed', summary: '已改完' }))

    const response = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: sendParams('把 README 改短') },
      { token, version: '1.0' },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      result?: { task?: { id: string; status?: { state: string } } }
    }
    expect(body.result?.task?.status?.state).toBe(taskStateToJSON(TaskState.TASK_STATE_COMPLETED))

    const taskId = body.result?.task?.id ?? ''
    expect(taskId).not.toBe('')

    /* 状态已持久化：GetTask 能查到同一个任务。 */
    const fetched = await post(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'GetTask',
        params: { tenant: '', id: taskId, historyLength: 0 },
      },
      { token, version: '1.0' },
    )
    const fetchedBody = (await fetched.json()) as { result?: { id: string } }
    expect(fetchedBody.result?.id).toBe(taskId)

    /* 并且真的落到了投影表（重启后仍是同一份数据）。 */
    const row = db.prepare('SELECT id FROM a2a_tasks WHERE id = ?').get(taskId) as
      | { id: string }
      | undefined
    expect(row?.id).toBe(taskId)
  })

  it('重启后（同一文件）任务仍可查询', async () => {
    const path = freshFile()
    const first = open(path)
    const { token } = registerPeer(first, { displayName: 'peer-a' })
    const app = serverApp(first, runner({ state: 'completed' }))
    const response = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: sendParams('任务一') },
      { token, version: '1.0' },
    )
    const taskId = ((await response.json()) as { result?: { task?: { id: string } } }).result?.task
      ?.id

    /* 模拟重启：关库、重新打开、重建 app（token 仍在库里）。 */
    first.close()
    dbs.pop()
    const second = open(path)
    const restarted = serverApp(second, runner({ state: 'completed' }))
    const fetched = await post(
      restarted,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'GetTask',
        params: { tenant: '', id: taskId, historyLength: 0 },
      },
      { token, version: '1.0' },
    )
    expect(fetched.status).toBe(200)
    expect(((await fetched.json()) as { result?: { id: string } }).result?.id).toBe(taskId)
  })

  it('未认证零副作用：401 且不创建任何任务', async () => {
    const db = open(freshFile())
    registerPeer(db, { displayName: 'peer-a' })
    const app = serverApp(db, runner({ state: 'completed' }))

    const response = await post(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: sendParams('不该执行'),
    })
    expect(response.status).toBe(401)

    const count = db.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('撤销后立即拒绝（不依赖对端配合）', async () => {
    const db = open(freshFile())
    const { peer, token } = registerPeer(db, { displayName: 'peer-a' })
    const app = serverApp(db, runner({ state: 'completed' }))

    expect(revokePeer(db, peer.id)).toBe(true)
    const response = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'ListTasks', params: { tenant: '' } },
      { token, version: '1.0' },
    )
    expect(response.status).toBe(401)
  })

  it('未声明版本被拒：缺 A2A-Version 时按规范当作 0.3，返回 -32009', async () => {
    const db = open(freshFile())
    const { token } = registerPeer(db, { displayName: 'peer-a' })
    const app = serverApp(db, runner({ state: 'completed' }))

    const response = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'ListTasks', params: { tenant: '' } },
      { token },
    )
    const body = (await response.json()) as { error?: { code: number } }
    expect(body.error?.code).toBe(-32009)
  })

  it('Agent Card 可被公开读取，且不声明 0.3', async () => {
    const db = open(freshFile())
    const app = serverApp(db, runner({ state: 'completed' }))

    const response = await app.request('/.well-known/agent-card.json')
    const card = (await response.json()) as {
      supportedInterfaces: Array<{ protocolVersion: string; protocolBinding: string }>
    }
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe('1.0')
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC')
  })
})
