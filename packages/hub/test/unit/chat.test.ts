import { afterEach, describe, expect, it } from 'vitest'
import type {
  BrainAction,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
} from '../../src/brain/types'
import { asChatThreadId } from '../../src/domain/ids'
import { createHttpApp } from '../../src/interfaces/http/app'
import { addAgent } from '../../src/runtime/agent-registry'
import { ChatService } from '../../src/runtime/chat/chat-service'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import {
  appendChatMessage,
  createChatThread,
  getChatThread,
  listChatMessages,
  listChatMessagesAfter,
  listChatThreads,
  updateChatThread,
} from '../../src/storage/queries/chat'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function database(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  dbs.push(db)
  return db
}

const provider = {
  describe: () => ({ kind: 'test' }),
  wrap: async () => {
    throw new Error('not used')
  },
  dispose: async () => undefined,
} as unknown as SandboxProvider

class RecordingBrain implements OrchestratorBrain {
  readonly inputs: BrainInput[] = []
  private readonly decide: (input: BrainInput) => BrainAction[]

  constructor(decide: (input: BrainInput) => BrainAction[]) {
    this.decide = decide
  }

  async step(input: BrainInput): Promise<BrainAction[]> {
    this.inputs.push(structuredClone(input))
    return this.decide(input)
  }

  async explain(): Promise<DecisionRationale[]> {
    return []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for chat run')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function conversationOf(brain: RecordingBrain, index: number) {
  return brain.inputs[index]?.conversation ?? []
}

describe('chat storage', () => {
  it('creates threads, appends messages, updates status', () => {
    const db = database()
    const thread = createChatThread(db, { title: 'Fix login' })
    expect(thread.status).toBe('idle')
    appendChatMessage(db, {
      threadId: thread.id,
      role: 'user',
      kind: 'text',
      content: 'hello',
    })
    updateChatThread(db, thread.id, { status: 'completed' })
    const loaded = getChatThread(db, thread.id)
    expect(loaded?.status).toBe('completed')
    const messages = listChatMessages(db, thread.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe('hello')
    const threads = listChatThreads(db)
    expect(threads[0]?.messageCount).toBe(1)
    expect(threads[0]?.lastMessage).toBe('hello')
  })

  it('pages latest messages and loads older by timestamp', () => {
    const db = database()
    const thread = createChatThread(db, { title: 'Paged' })
    for (let index = 0; index < 25; index += 1) {
      appendChatMessage(db, {
        threadId: thread.id,
        role: 'user',
        kind: 'text',
        content: `message ${index}`,
      })
      db.prepare('UPDATE chat_messages SET created_at = ? WHERE content = ?').run(
        `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        `message ${index}`,
      )
    }
    const latest = listChatMessages(db, thread.id, { limit: 10 })
    expect(latest).toHaveLength(10)
    expect(latest[0]?.content).toBe('message 15')
    expect(latest[9]?.content).toBe('message 24')
    const older = listChatMessages(db, thread.id, {
      limit: 10,
      before: latest[0]?.createdAt,
    })
    expect(older).toHaveLength(10)
    expect(older[0]?.content).toBe('message 5')
  })

  it('lists only the messages strictly after a cursor', () => {
    const db = database()
    const thread = createChatThread(db, { title: 'Cursor' })
    for (let index = 0; index < 5; index += 1) {
      appendChatMessage(db, {
        threadId: thread.id,
        role: 'user',
        kind: 'text',
        content: `message ${index}`,
      })
      /* Same timestamp on purpose: ties must break by id, not by insertion luck. */
      db.prepare('UPDATE chat_messages SET created_at = ? WHERE content = ?').run(
        '2026-01-01T00:00:00.000Z',
        `message ${index}`,
      )
    }
    const all = listChatMessagesAfter(db, thread.id, undefined, 100)
    expect(all.map((entry) => entry.message.content)).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ])
    /* rowid order is insertion order, which the ULID alone cannot give us. */
    expect(all[0]?.seq).toBeLessThan(all[1]?.seq ?? 0)

    const cursor = all[1]?.seq
    const rest = listChatMessagesAfter(db, thread.id, cursor, 100)
    expect(rest.map((entry) => entry.message.content)).toEqual([
      'message 2',
      'message 3',
      'message 4',
    ])

    const firstPage = listChatMessagesAfter(db, thread.id, undefined, 2)
    expect(firstPage).toHaveLength(2)
  })

  it('直接回复不建任务，并把上一轮带进上下文', async () => {
    const db = database()
    addAgent(db, { name: 'mock', command: 'mock-acp' })
    const brain = new RecordingBrain((input) => [
      { type: 'reply', text: `收到：${input.goal.intent}` },
    ])
    const chat = new ChatService({ db, provider, clientVersion: 'test', brain })
    const thread = chat.createThread({})

    await chat.postMessage(thread.id, { text: 'hi' })
    await waitFor(() => getChatThread(db, thread.id)?.status === 'completed')
    const first = chat.getThread(thread.id)
    expect(first?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(first?.messages[1]?.content).toBe('收到：hi')
    expect(first?.thread.taskId).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })

    /* 执行过程与授权卡属于 UI 噪声，不能进模型上下文。 */
    appendChatMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      kind: 'progress',
      content: '派给 mock：开始执行',
      agentName: 'mock',
    })
    appendChatMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      kind: 'auth',
      content: 'session/new 失败：Authentication required',
      agentName: 'mock',
    })

    await chat.postMessage(thread.id, { text: '再问一句' })
    await waitFor(
      () => brain.inputs.length === 2 && getChatThread(db, thread.id)?.status === 'completed',
    )
    expect(conversationOf(brain, 1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '收到：hi' },
    ])
  })

  it('需要澄清时停在 waiting，选项答案继续对话且不建任务', async () => {
    const db = database()
    addAgent(db, { name: 'mock', command: 'mock-acp' })
    const brain = new RecordingBrain((input) =>
      input.conversation === undefined
        ? [
            {
              type: 'request_human',
              kind: 'decide',
              question: '你想做什么？',
              options: ['只是打招呼', '写点代码'],
            },
          ]
        : [{ type: 'reply', text: `好的：${input.goal.intent}` }],
    )
    const chat = new ChatService({ db, provider, clientVersion: 'test', brain })
    const thread = chat.createThread({})

    await chat.postMessage(thread.id, { text: 'hi' })
    await waitFor(() => getChatThread(db, thread.id)?.status === 'waiting')
    const waiting = chat.getThread(thread.id)
    const card = waiting?.messages.find((message) => message.kind === 'clarification')
    expect(card?.clarificationId).toBeDefined()

    const app = createHttpApp({ db, token: 'token', chat })
    const response = await app.request(`/api/v1/clarifications/${card?.clarificationId}`, {
      headers: { authorization: 'Bearer token' },
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { clarification: { options: string[] } }
    expect(payload.clarification.options).toEqual(['只是打招呼', '写点代码'])

    await chat.answer(thread.id, card?.clarificationId ?? '', '只是打招呼')
    await waitFor(() => getChatThread(db, thread.id)?.status === 'completed')
    const answered = chat.getThread(thread.id)
    expect(answered?.messages.at(-1)?.content).toBe('好的：只是打招呼')
    expect(conversationOf(brain, 1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '你想做什么？' },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })
})

describe('chat HTTP API', () => {
  it('streams messages after a cursor and reports terminal status', async () => {
    const db = database()
    const thread = createChatThread(db, { title: 'Stream' })
    const first = appendChatMessage(db, {
      threadId: thread.id,
      role: 'user',
      kind: 'text',
      content: 'hello',
    })
    const second = appendChatMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      kind: 'result',
      content: 'done',
    })
    /* A finished thread closes the stream synchronously after the backlog. */
    updateChatThread(db, thread.id, { status: 'completed' })

    const firstSeq = listChatMessagesAfter(db, thread.id, undefined, 100)[0]?.seq ?? 0
    const app = createHttpApp({ db, token: 'token' })
    const response = await app.request(
      `/api/v1/chat/threads/${thread.id}/stream?token=token&after=${firstSeq}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('event: message')
    expect(body).toContain(second.id)
    expect(body).not.toContain(first.id)
    expect(body).toContain('event: status')
    expect(body).toContain('"status":"completed"')
  })

  it('creates a thread, posts a message, and returns messages', async () => {
    const db = database()
    addAgent(db, { name: 'mock', command: 'mock-acp' })
    const brain = new RecordingBrain(() => [{ type: 'reply', text: '好的' }])
    const chat = new ChatService({ db, provider, clientVersion: 'test', brain })
    const app = createHttpApp({ db, token: 'token', chat })
    const created = await app.request('/api/v1/chat/threads', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Thread' }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { thread: { id: string } }
    const posted = await app.request(`/api/v1/chat/threads/${body.thread.id}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '在吗' }),
    })
    expect(posted.status).toBe(202)
    await waitFor(() => getChatThread(db, asChatThreadId(body.thread.id))?.status === 'completed')
    const detail = await app.request(`/api/v1/chat/threads/${body.thread.id}`, {
      headers: { authorization: 'Bearer token' },
    })
    expect(detail.status).toBe(200)
    const payload = (await detail.json()) as { messages: Array<{ content: string }> }
    expect(payload.messages.map((message) => message.content)).toEqual(['在吗', '好的'])
  })
})
