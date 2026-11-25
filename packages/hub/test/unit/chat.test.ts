import { afterEach, describe, expect, it } from 'vitest'
import { createHttpApp } from '../../src/interfaces/http/app'
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

describe('chat storage', () => {
  it('creates threads, appends messages, updates status', () => {
    const db = database()
    const thread = createChatThread(db, { title: 'Fix login' })
    expect(thread.status).toBe('active')
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

  it('ask mode answers from the snapshot without starting a run', async () => {
    const db = database()
    const chat = new ChatService({ db, provider, clientVersion: 'test' })
    const thread = chat.createThread({ title: 'Status' })
    const result = await chat.postMessage(thread.id, { text: 'what is happening?', mode: 'ask' })
    expect(result.status).toBe('active')
    const detail = chat.getThread(thread.id)
    expect(detail?.messages.some((message) => message.role === 'assistant')).toBe(true)
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
    const chat = new ChatService({ db, provider, clientVersion: 'test' })
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
      body: JSON.stringify({ text: 'status?', mode: 'ask' }),
    })
    expect(posted.status).toBe(202)
    const detail = await app.request(`/api/v1/chat/threads/${body.thread.id}`, {
      headers: { authorization: 'Bearer token' },
    })
    expect(detail.status).toBe(200)
    const payload = (await detail.json()) as { messages: unknown[] }
    expect(payload.messages.length).toBeGreaterThanOrEqual(2)
  })
})
