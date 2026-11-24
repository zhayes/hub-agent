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
