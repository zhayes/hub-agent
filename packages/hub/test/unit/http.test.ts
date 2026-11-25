import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asGoalId, asSubtaskId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { emptyState } from '../../src/domain/machine'
import { createHttpApp } from '../../src/interfaces/http/app'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function seed(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  const at = asTimestamp(new Date().toISOString())
  let state = appendEvent(db, emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('g1'),
      userId: 'local',
      title: 'goal',
      intent: 'goal',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  }).state
  state = appendEvent(db, state, {
    type: 'task.created',
    task: {
      id: asTaskId('t1'),
      goalId: asGoalId('g1'),
      title: 'task',
      description: 'task',
      status: 'draft',
      priority: 0,
      acceptanceCriteria: [],
      createdAt: at,
      updatedAt: at,
    },
  }).state
  appendEvent(db, state, {
    type: 'subtask.created',
    subtask: {
      id: asSubtaskId('s1'),
      taskId: asTaskId('t1'),
      title: 'subtask',
      description: 'subtask',
      status: 'ready',
      required: true,
      dependencies: [],
      requiredCapabilities: [],
      priority: 0,
      maxAttempts: 1,
      createdAt: at,
      updatedAt: at,
    },
  })
  return db
}

describe('HTTP API', () => {
  it('缺 token 401；带 token 返回 tasks 与 task detail', async () => {
    const app = createHttpApp({ db: seed(), token: 'test-token' })
    const denied = await app.request('/api/v1/tasks')
    expect(denied.status).toBe(401)

    const tasks = await app.request('/api/v1/tasks', {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(tasks.status).toBe(200)
    const payload = (await tasks.json()) as { tasks: Array<{ id: string }> }
    expect(payload.tasks[0]?.id).toBe('t1')

    const detail = await app.request('/api/v1/tasks/t1', {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { task: { id: string } }).task.id).toBe('t1')
  })

  it('SSE 返回事件流与 sinceSeq', async () => {
    const db = seed()
    const app = createHttpApp({ db, token: 't' })
    const response = await app.request('/api/v1/events/stream?sinceSeq=0', {
      headers: { authorization: 'Bearer t' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()
    const chunk = await Promise.race([
      reader?.read(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ])
    await reader?.cancel()
    if (chunk !== undefined) {
      const text = new TextDecoder().decode(chunk.value)
      expect(text).toContain('event: hubagent')
      expect(text).toContain('goal.created')
    }
  })
})

describe('模型设置端点', () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hubagent-http-model-'))
  }

  it('GET 未配置时返回空视图，不读用户 home', async () => {
    const app = createHttpApp({ db: seed(), token: 't', modelDir: tempDir() })
    const response = await app.request('/api/v1/settings/model', {
      headers: { authorization: 'Bearer t' },
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      model: { apiKeySet: boolean; providerId?: string }
    }
    expect(payload.model.apiKeySet).toBe(false)
    expect(payload.model.providerId).toBeUndefined()
  })

  it('PUT 写入后 GET 能读回，且不回传明文 key', async () => {
    const dir = tempDir()
    const app = createHttpApp({ db: seed(), token: 't', modelDir: dir })
    const put = await app.request('/api/v1/settings/model', {
      method: 'PUT',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'local-proxy',
        modelId: 'qwen2.5-coder:7b',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'sk-secret-9876wxyz',
      }),
    })
    expect(put.status).toBe(200)
    const saved = (await put.json()) as { model: { apiKeyHint?: string } }
    expect(saved.model.apiKeyHint).toBe('…wxyz')

    const get = await app.request('/api/v1/settings/model', {
      headers: { authorization: 'Bearer t' },
    })
    const text = await get.text()
    expect(text).not.toContain('sk-secret-9876wxyz')
    expect(text).toContain('local-proxy')
  })

  it('非法请求体返回 400 与稳定错误码', async () => {
    const app = createHttpApp({ db: seed(), token: 't', modelDir: tempDir() })
    const response = await app.request('/api/v1/settings/model', {
      method: 'PUT',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'Bad Id', modelId: 'm1' }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('CONFIG_INVALID')
  })
})

describe('Web Console 静态托管', () => {
  it('index 注入 token；SSE 可用 query token', async () => {
    const db = seed()
    const app = createHttpApp({
      db,
      token: 'web-token',
      webDist: resolve('packages/web/dist'),
    })
    const index = await app.request('/')
    expect(index.status).toBe(200)
    const html = await index.text()
    expect(html).toContain('__HUBAGENT_TOKEN__')
    expect(html).toContain('web-token')

    const stream = await app.request('/api/v1/events/stream?token=web-token&sinceSeq=0')
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    await stream.body?.cancel()
  })
})
