import { afterEach, describe, expect, it } from 'vitest'
import { type A2aServerHandle, startA2aServer } from '../../src/interfaces/a2a/server'
import type { InboundTaskRunner } from '../../src/runtime/a2a-executor'
import { listDecisionPoints } from '../../src/runtime/decision-queue'
import { enqueueDispatch } from '../../src/runtime/dispatch/queue'
import { drainDispatches } from '../../src/runtime/dispatch/runner'
import { createRemoteDispatchExecutor, type PeerEndpoint } from '../../src/runtime/remote-dispatch'
import { reconcileRemoteTasks } from '../../src/runtime/remote-reconcile'
import { findRemoteTaskByIdempotencyKey } from '../../src/runtime/remote-task'
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

interface Node {
  database: Db
  url: string
  /** 收到的目标文本，按到达顺序。 */
  received: string[]
}

/**
 * 起一个真实的 A2A 入站面（与 daemon 用的是同一个 `startA2aServer`）。
 *
 * `acceptToken` 是**它对别人出示的** token：只有带着这个 token 的请求才会被受理。
 */
async function startNode(acceptToken: string, reply: (objective: string) => string): Promise<Node> {
  const database = db()
  const received: string[] = []
  const runner: InboundTaskRunner = {
    run: async ({ objective }) => {
      received.push(objective)
      return { state: 'completed', summary: reply(objective) }
    },
    cancel: async () => ({ contextId: 'ctx' }),
  }
  const handle = await startA2aServer({
    db: database,
    provider: stubProvider,
    version: '0.0.0-test',
    worktree: '/tmp',
    port: 0,
    peers: [{ displayName: 'peer', token: acceptToken }],
    runner,
  })
  handles.push(handle)
  return { database, url: handle.url, received }
}

/** A 侧：落派发意图 → 真实 A2A 提交 → 返回意图 id。 */
async function delegate(
  from: Db,
  to: PeerEndpoint,
  objective: string,
  idempotencyKey: string,
): Promise<{ intentId: string; handled: string[] }> {
  const enqueued = enqueueDispatch(from, {
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'remote-a2a',
    objective,
    idempotencyKey,
    payload: { peerId: 'target' },
  })
  const executor = createRemoteDispatchExecutor({
    db: from,
    resolvePeer: () => to,
  })
  const report = await drainDispatches(from, { executor, intentId: enqueued.intent.id })
  return { intentId: enqueued.intent.id, handled: report.handled }
}

/** 轮询对账直到远端终态；`staleAfterMs: 0` 让每次调用都可立即对账。 */
async function waitTerminal(from: Db, to: PeerEndpoint): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const report = await reconcileRemoteTasks({
      db: from,
      resolvePeer: () => to,
      staleAfterMs: 0,
    })
    if (report.terminal.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('远端未在预期时间内到达终态')
}

describe('两个 HubAgent 运行时互相委托（真实 A2A 往返）', () => {
  it('A 委托 B、B 委托 A；各自落关联并对账到终态，各产出一条决策点', async () => {
    /* 各自出示给对方的 token。 */
    const tokenForB = 'token-that-B-accepts'
    const tokenForA = 'token-that-A-accepts'

    const a = await startNode(tokenForA, (objective) => `A 收到：${objective}`)
    const b = await startNode(tokenForB, (objective) => `B 收到：${objective}`)

    /* A → B：A 用 B 出示的 token 调 B。 */
    const aToB: PeerEndpoint = { url: b.url, token: tokenForB }
    const sentByA = await delegate(a.database, aToB, '算出这手牌的最优动作', 'key-a-to-b')
    expect(sentByA.handled).toEqual([sentByA.intentId])
    expect(b.received).toEqual(['算出这手牌的最优动作'])

    await waitTerminal(a.database, aToB)
    const refAB = findRemoteTaskByIdempotencyKey(a.database, 'key-a-to-b')
    expect(refAB?.observedState).toBe('completed')
    expect(refAB?.localExecutionId).toBeUndefined()
    const decisionsA = listDecisionPoints(a.database, 'g1')
    expect(decisionsA).toHaveLength(1)
    expect(decisionsA[0]?.dedupeKey).toBe(`remote:${refAB?.id}:terminal`)

    /* B → A：反方向同样成立。 */
    const bToA: PeerEndpoint = { url: a.url, token: tokenForA }
    const sentByB = await delegate(b.database, bToA, '把这份日志归并', 'key-b-to-a')
    expect(sentByB.handled).toEqual([sentByB.intentId])
    expect(a.received).toEqual(['把这份日志归并'])

    await waitTerminal(b.database, bToA)
    expect(findRemoteTaskByIdempotencyKey(b.database, 'key-b-to-a')?.observedState).toBe(
      'completed',
    )
    expect(listDecisionPoints(b.database, 'g1')).toHaveLength(1)

    /* 重复对账不会重复产出决策点（dedupeKey 生效）。 */
    await reconcileRemoteTasks({ db: a.database, resolvePeer: () => aToB, staleAfterMs: 0 })
    expect(listDecisionPoints(a.database, 'g1')).toHaveLength(1)
  })

  it('同一幂等键重放不会第二次委托给远端', async () => {
    const tokenForB = 'token-that-B-accepts'
    const a = await startNode('token-that-A-accepts', () => 'ok')
    const b = await startNode(tokenForB, (objective) => `B 收到：${objective}`)
    const aToB: PeerEndpoint = { url: b.url, token: tokenForB }

    await delegate(a.database, aToB, '只该发一次', 'key-once')
    await waitTerminal(a.database, aToB)

    /* 同一幂等键再次入队：INSERT OR IGNORE 命中已完成的意图，不会再派发。 */
    const replay = await delegate(a.database, aToB, '只该发一次', 'key-once')
    expect(replay.handled).toEqual([])
    expect(b.received).toEqual(['只该发一次'])
  })
})
