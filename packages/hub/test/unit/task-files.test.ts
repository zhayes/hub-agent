import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Execution, Goal, Subtask, Task } from '../../src/domain/entities'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
} from '../../src/domain/ids'
import { readTaskFile } from '../../src/runtime/task-files'
import { acquireLease } from '../../src/runtime/workspace/lease'
import { ensureProject } from '../../src/runtime/workspace/project'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { appendEvent } from '../../src/storage/write/events'

const dbs: Db[] = []
const dirs: string[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-files-'))
  dirs.push(dir)
  return dir
}

function seed() {
  const db = openDatabase(':memory:')
  dbs.push(db)
  migrate(db)
  const at = asTimestamp(new Date().toISOString())
  const goal: Goal = {
    id: asGoalId('g1'),
    userId: 'local',
    title: 'g',
    intent: 'g',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const task: Task = {
    id: asTaskId('t1'),
    goalId: goal.id,
    title: 't',
    description: 't',
    status: 'draft',
    priority: 0,
    acceptanceCriteria: [],
    createdAt: at,
    updatedAt: at,
  }
  const subtask: Subtask = {
    id: asSubtaskId('s1'),
    taskId: task.id,
    title: 's',
    description: 's',
    status: 'ready',
    required: true,
    dependencies: [],
    requiredCapabilities: [],
    assignedAgentId: asAgentId('a1'),
    priority: 0,
    maxAttempts: 1,
    createdAt: at,
    updatedAt: at,
  }
  const execution: Execution = {
    id: asExecutionId('e1'),
    taskId: task.id,
    subtaskId: subtask.id,
    agentId: asAgentId('a1'),
    status: 'created',
    attempt: 1,
    createdAt: at,
  }
  let state = appendEvent(db, loadState(db), { type: 'goal.created', goal }).state
  state = appendEvent(db, state, { type: 'task.created', task }).state
  state = appendEvent(db, state, { type: 'subtask.created', subtask }).state
  state = appendEvent(db, state, { type: 'execution.created', execution }).state
  appendEvent(db, state, {
    type: 'execution.evidence',
    executionId: execution.id,
    evidence: { changedFiles: ['src/a.ts'], transcriptRef: 'transcript://e1' },
  })
  return { db, executionId: execution.id, taskId: String(task.id) }
}

import { loadState } from '../../src/storage/queries/state'

describe('任务文件只读预览', () => {
  it('读取改动文件内容；越界路径与非改动文件被拒', () => {
    const worktree = tempDir()
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src/a.ts'), 'export const a = 1\n')
    const { db, executionId, taskId } = seed()
    const project = ensureProject(db, worktree)
    acquireLease(db, {
      projectId: project.id,
      executionId,
      mode: 'worktree',
      path: worktree,
      holderAgentId: 'a1',
    })

    const file = readTaskFile(db, taskId, 'src/a.ts')
    expect(file.content).toContain('export const a')
    expect(file.source).toBe('worktree')

    expect(() => readTaskFile(db, taskId, '../etc/passwd')).toThrowError(/非法文件路径/)
    expect(() => readTaskFile(db, taskId, 'src/other.ts')).toThrowError(/只能预览/)
  })
})
