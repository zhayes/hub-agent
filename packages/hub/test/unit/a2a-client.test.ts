import { TaskState, taskStateToJSON } from '@a2a-js/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { connectRemoteAgent } from '../../src/adapters/a2a/client'
import { type A2aServerHandle, startA2aServer } from '../../src/interfaces/a2a/server'
import type { InboundTaskRunner } from '../../src/runtime/a2a-executor'
import { registerPeer } from '../../src/runtime/a2a-peers'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []
const handles: A2aServerHandle[] = []

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close()
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

const stubProvider = {
  describe: () => ({ kind: 'srt', platform: 'test', ready: true, detail: '' }),
  wrap: () => {
    throw new Error('stub provider 不该被调用')
  },
  dispose: async () => {},
} as unknown as SandboxProvider

async function serve(runner: InboundTaskRunner) {
  const database = db()
  const { token } = registerPeer(database, { displayName: 'peer-a' })
  const handle = await startA2aServer({
    db: database,
    provider: stubProvider,
    version: '0.0.0-test',
    worktree: '/tmp',
    port: 0,
    peers: [{ displayName: 'bootstrap', token }],
    runner,
  })
  handles.push(handle)
  return { handle, token, database }
}

function runner(onRun: () => Promise<'completed' | 'input_required'>): InboundTaskRunner {
  return {
    run: async () => {
      const state = await onRun()
      return state === 'completed'
        ? { state: 'completed' as const, summary: '改完了' }
        : { state: 'input_required' as const, question: '要改哪个 README？' }
    },
    cancel: async () => ({ contextId: 'ctx' }),
  }
}

describe('A2A 出站客户端（真实 HTTP 往返）', () => {
  it('拉卡片 → 非阻塞发送 → 轮询到终态', async () => {
    const { handle, token } = await serve(runner(async () => 'completed'))
    const client = await connectRemoteAgent({ url: handle.url.replace('/a2a', ''), token })

    const card = await client.card()
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe('1.0')

    const sent = await client.send({ text: '把 README 改短' })
    expect(sent.taskId).not.toBe('')
    expect(sent.contextId).not.toBe('')
    /* 非阻塞：拿到的是任务标识，不保证已经结束。 */
    expect(taskStateToJSON(sent.state)).toMatch(/^TASK_STATE_/)

    /* 轮询到终态；我们的 stub 立即完成，所以很快收敛。 */
    const done = await client.get(sent.taskId)
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('对端停在 INPUT_REQUIRED 时可读到可续状态（不是终态）', async () => {
    const { handle, token } = await serve(runner(async () => 'input_required'))
    const client = await connectRemoteAgent({ url: handle.url.replace('/a2a', ''), token })

    const sent = await client.send({ text: '需要澄清的任务' })
    const task = await client.get(sent.taskId)
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
  })

  it('token 错误时客户端拿不到任务（认证失败可见）', async () => {
    const { handle } = await serve(runner(async () => 'completed'))
    const client = await connectRemoteAgent({ url: handle.url.replace('/a2a', ''), token: 'wrong' })

    await expect(client.send({ text: '不该成功' })).rejects.toBeTruthy()
  })

  it('取消已终态任务会被对端拒绝，而不是静默当成成功', async () => {
    const { handle, token } = await serve(runner(async () => 'completed'))
    const client = await connectRemoteAgent({ url: handle.url.replace('/a2a', ''), token })

    const sent = await client.send({ text: '立刻完成' })
    await client.get(sent.taskId)
    await expect(client.cancel(sent.taskId)).rejects.toBeTruthy()
  })
})
