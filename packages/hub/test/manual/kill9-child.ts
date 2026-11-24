import { asGoalId, asTaskId, asTimestamp } from '../../src/domain/ids'
import { type DomainState, emptyState } from '../../src/domain/machine'
import { openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

/**
 * kill -9 的被试进程：持续写事件，父进程随时可能暴力终止它。
 *
 * 只做一件事：不停地在 `running` 与 `paused` 之间迁移 Task，
 * 每写一个事件就把它自己的 seq 打到 stdout，供父进程判断写过多少。
 */

const dbFile = process.argv[2]
if (dbFile === undefined) {
  process.stderr.write('usage: kill9-child <db-path>\n')
  process.exit(2)
}

const db = openDatabase(dbFile)
migrate(db)

const at = asTimestamp(new Date().toISOString())

let state: DomainState = emptyState

state = appendEvent(db, state, {
  type: 'goal.created',
  goal: {
    id: asGoalId('g-kill9'),
    userId: 'u-kill9',
    title: 'kill -9 一致性',
    intent: '验证写一半被杀后重启状态一致',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  },
}).state

state = appendEvent(db, state, {
  type: 'task.created',
  task: {
    id: asTaskId('t-kill9'),
    goalId: asGoalId('g-kill9'),
    title: '在 running / paused 之间来回迁移',
    description: 'kill9 子进程',
    status: 'ready',
    priority: 1,
    acceptanceCriteria: [],
    createdAt: at,
    updatedAt: at,
  },
}).state

// ready → running → paused → running → …（两条迁移都在表里合法）
const CYCLE = ['running', 'paused'] as const

for (let i = 0; ; i += 1) {
  const to = CYCLE[i % CYCLE.length]
  if (to === undefined) break // 不可达，仅为满足 noUncheckedIndexedAccess

  const result = appendEvent(db, state, {
    type: 'task.status',
    taskId: asTaskId('t-kill9'),
    to,
    at: asTimestamp(new Date().toISOString()),
  })
  state = result.state

  // 每写一条就报一次：父进程据此确认"确实写过"。
  process.stdout.write(`${result.seq}\n`)
}
