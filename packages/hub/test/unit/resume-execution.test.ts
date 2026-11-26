import { mkdtempSync, rmSync } from 'node:fs'
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
import { createSandboxDeniedApproval, decideApproval } from '../../src/runtime/approval'
import { resumeExecution } from '../../src/runtime/resume-execution'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'
import { saveExecutionResume } from '../../src/storage/queries/execution-resume'
import { loadState } from '../../src/storage/queries/state'
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

class ShellProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }
  async wrap(command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    return { argv: ['/bin/bash', '-c', command], env: { ...process.env } }
  }
  async dispose(): Promise<void> {}
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-resume-'))
  dirs.push(dir)
  return dir
}

function seed(worktree: string) {
  const db = openDatabase(':memory:')
  dbs.push(db)
  migrate(db)
  const at = asTimestamp(new Date().toISOString())
  const goal: Goal = {
    id: asGoalId('g1'),
    userId: 'local',
    title: 'goal',
    intent: 'goal',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }
  const task: Task = {
    id: asTaskId('t1'),
    goalId: goal.id,
    title: 'task',
    description: 'task',
    status: 'draft',
    priority: 0,
    acceptanceCriteria: [],
    createdAt: at,
    updatedAt: at,
  }
  const subtask: Subtask = {
    id: asSubtaskId('s1'),
    taskId: task.id,
    title: 'subtask',
    description: 'subtask',
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
  for (const to of ['planning', 'ready', 'running', 'waiting_approval'] as const) {
    state = appendEvent(db, state, { type: 'task.status', taskId: task.id, to, at }).state
  }
  state = appendEvent(db, state, { type: 'subtask.created', subtask }).state
  for (const to of ['assigned', 'running', 'waiting_approval'] as const) {
    state = appendEvent(db, state, { type: 'subtask.status', subtaskId: subtask.id, to, at }).state
  }
  state = appendEvent(db, state, { type: 'execution.created', execution }).state
  state = appendEvent(db, state, {
    type: 'execution.evidence',
    executionId: execution.id,
    evidence: { changedFiles: ['x.txt'], transcriptRef: 'transcript://e1' },
  }).state
  for (const to of ['starting', 'running', 'waiting_permission'] as const) {
    state = appendEvent(db, state, {
      type: 'execution.status',
      executionId: execution.id,
      to,
      at,
    }).state
  }
  const approval = createSandboxDeniedApproval({
    taskId: task.id,
    executionId: execution.id,
    agentId: execution.agentId,
    source: 'printf ok',
    text: 'Operation not permitted',
  })
  appendEvent(db, state, { type: 'approval.requested', approval })
  decideApproval(db, approval.id, 'approved')
  saveExecutionResume(db, {
    executionId: execution.id,
    worktree,
    checks: [{ kind: 'command', cmd: 'printf ok', timeoutMs: 5_000, expect: { exitCode: 0 } }],
  })
  return { db, approval, executionId: execution.id }
}

describe('精确续跑：同一 execution', () => {
  it('批准后原地重跑验收，不新增 execution，任务完成', async () => {
    const worktree = tempDir()
    const { db, approval, executionId } = seed(worktree)
    const result = await resumeExecution({
      db,
      provider: new ShellProvider(),
      approvalId: approval.id,
    })
    expect(result.ok).toBe(true)
    expect(result.verdict).toBe('pass')

    const state = loadState(db)
    expect(Object.values(state.executions)).toHaveLength(1)
    expect(state.executions[executionId]?.status).toBe('succeeded')
    expect(state.subtasks.s1?.status).toBe('succeeded')
    expect(state.tasks.t1?.status).toBe('completed')
    expect(Object.values(state.verifications)).toHaveLength(1)
  })

  it('工作区不存在时拒绝续跑，不伪造成功', async () => {
    const { db, approval } = seed(join(tempDir(), 'gone'))
    await expect(
      resumeExecution({ db, provider: new ShellProvider(), approvalId: approval.id }),
    ).rejects.toThrowError(/工作区已回收/)
  })
})
