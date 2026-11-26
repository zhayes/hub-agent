import { afterEach, describe, expect, it } from 'vitest'
import { enqueueDecisionPoint, listDecisionPoints } from '../../src/runtime/decision-queue'
import { claimDispatch, enqueueDispatch, listDispatches } from '../../src/runtime/dispatch/queue'
import type { DispatchIntent } from '../../src/runtime/dispatch/types'
import {
  createLocalAcpExecutor,
  parseDispatchSpec,
} from '../../src/runtime/scheduler/local-executor'
import { runSchedulerTick } from '../../src/runtime/scheduler/tick'
import type { SandboxProvider } from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const at = (n: number): Date => new Date(T0.getTime() + n * 60_000)

function seed(database: Db) {
  return enqueueDispatch(database, {
    goalId: 'g1',
    taskId: 't1',
    subtaskId: 's1',
    target: 'local-acp',
    agentId: 'a1',
    objective: '改一个文件',
    idempotencyKey: 'g1:s1:1',
    payload: { worktree: '/tmp/hubagent-test' },
  })
}

function okExecutor() {
  return async (intent: DispatchIntent) => ({
    ok: true,
    nextDecision: {
      reason: 'subtask_terminal',
      dedupeKey: `subtask:${intent.subtaskId}:terminal`,
    },
  })
}

function statusOf(database: Db, id: string): string {
  const row = database.prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(id) as {
    status: string
  }
  return row.status
}

describe('scheduler tick', () => {
  it('消费 pending 意图并写下下一决策点', async () => {
    const database = db()
    const { intent } = seed(database)

    const report = await runSchedulerTick(database, { createExecutor: () => okExecutor() })

    expect(report.handled).toEqual([intent.id])
    expect(statusOf(database, intent.id)).toBe('done')
    const decisions = listDecisionPoints(database, 'g1')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.dedupeKey).toBe('subtask:s1:terminal')
  })

  it('先回收过期 claim，再把遗留意图重新跑完', async () => {
    const database = db()
    const { intent } = seed(database)
    /* 模拟上一个进程领了意图、还没收尾就死了。 */
    claimDispatch(database, { claimedBy: 'dead-process', now: T0 })
    expect(statusOf(database, intent.id)).toBe('claimed')

    const report = await runSchedulerTick(database, {
      createExecutor: () => okExecutor(),
      now: at(40),
    })

    expect(report.reclaimedDispatches).toEqual([intent.id])
    expect(report.handled).toEqual([intent.id])
    expect(statusOf(database, intent.id)).toBe('done')
  })

  it('没有活可干时是空转，不报错', async () => {
    const database = db()
    const report = await runSchedulerTick(database, { createExecutor: () => okExecutor() })

    expect(report.reclaimedDecisionPoints).toEqual([])
    expect(report.reclaimedDispatches).toEqual([])
    expect(report.handled).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.pendingDecisionGoals).toEqual([])
  })

  it('上报仍需 Brain 回合推进的 Goal', async () => {
    const database = db()
    enqueueDecisionPoint(database, {
      goalId: 'g9',
      reason: 'subtask_terminal',
      dedupeKey: 'g9:s1:terminal',
    })

    const report = await runSchedulerTick(database, { createExecutor: () => okExecutor() })

    expect(report.pendingDecisionGoals).toEqual(['g9'])
  })

  it('意图缺执行规格时失败关闭，不会静默空跑', async () => {
    const database = db()
    const { intent } = seed(database)
    /* 抹掉 payload，模拟旧版本入队的意图。 */
    database.prepare('UPDATE dispatch_queue SET payload = NULL WHERE id = ?').run(intent.id)

    const executor = createLocalAcpExecutor({
      db: database,
      provider: {} as SandboxProvider,
      findAgent: () => undefined,
    })

    const report = await runSchedulerTick(database, { createExecutor: () => executor })

    expect(report.failed).toEqual([intent.id])
    expect(statusOf(database, intent.id)).toBe('failed')
    expect(listDispatches(database, 'g1')[0]?.error).toContain('payload')
  })
})

describe('parseDispatchSpec', () => {
  it('接受带 worktree 的规格', () => {
    expect(parseDispatchSpec({ worktree: '/w', checks: [], networkMode: 'agent-managed' })).toEqual(
      {
        worktree: '/w',
        checks: [],
        networkMode: 'agent-managed',
      },
    )
  })

  it('缺 worktree 时拒绝', () => {
    expect(() => parseDispatchSpec({})).toThrow()
    expect(() => parseDispatchSpec(null)).toThrow()
    expect(() => parseDispatchSpec({ worktree: '' })).toThrow()
  })
})

describe('调度器边界：不代替 Brain 决策（ADR 0027 D5）', () => {
  it('tick 只上报 pending 决策点，不领取、不改状态', async () => {
    const database = db()
    enqueueDecisionPoint(database, {
      goalId: 'g1',
      reason: 'subtask_terminal',
      dedupeKey: 'g1:after-dispatch',
    })

    const report = await runSchedulerTick(database, { createExecutor: () => okExecutor() })

    expect(report.pendingDecisionGoals).toEqual(['g1'])
    /* 边界：没有 Brain 回合就不能推进它——tick 不得偷偷 claim。 */
    expect(listDecisionPoints(database, 'g1')[0]?.status).toBe('pending')
  })
})
