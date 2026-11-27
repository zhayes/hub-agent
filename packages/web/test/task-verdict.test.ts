import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/shared/api'
import {
  attemptMs,
  currentVerification,
  diffTotals,
  elapsedMs,
  evidenceExecution,
  executionAgents,
  failingCheck,
  failureReport,
  latestExecution,
  taskPhase,
} from '../src/features/tasks/verdict'

function view(patch: Partial<TaskView> = {}): TaskView {
  return {
    task: { id: 'task1', goalId: 'g1', title: '修复重定向', status: 'completed', description: '' },
    subtasks: [],
    executions: [],
    verifications: [],
    approvals: [],
    ...patch,
  }
}

const stat = [
  ' src/auth/redirect.ts | 50 +++++++++++++++++++++++-------------------',
  ' src/auth/session.ts  | 76 +++++++++++++++++++++++++++++++++++++----------------',
  ' 2 files changed, 92 insertions(+), 34 deletions(-)',
].join('\n')

describe('taskPhase', () => {
  it('treats a passing verification on a completed task as done', () => {
    const subject = view({
      executions: [{ id: 'exe1', status: 'completed', attempt: 1, startedAt: '2026-11-27T10:00:00Z', finishedAt: '2026-11-27T10:02:00Z' }],
      verifications: [{ id: 'v1', executionId: 'exe1', verdict: 'pass', checks: [] }],
    })
    expect(taskPhase(subject, 0)).toBe('done')
  })

  it('does not let an earlier failed attempt override a later passing one', () => {
    const subject = view({
      executions: [
        { id: 'exe1', status: 'failed', attempt: 1, startedAt: '2026-11-27T10:00:00Z', finishedAt: '2026-11-27T10:02:00Z' },
        { id: 'exe2', status: 'completed', attempt: 2, startedAt: '2026-11-27T10:03:00Z', finishedAt: '2026-11-27T10:05:00Z' },
      ],
      verifications: [
        { id: 'v1', executionId: 'exe1', verdict: 'fail', checks: [] },
        { id: 'v2', executionId: 'exe2', verdict: 'pass', checks: [] },
      ],
    })
    expect(currentVerification(subject)?.id).toBe('v2')
    expect(taskPhase(subject, 0)).toBe('done')
    expect(failingCheck(subject)).toBeUndefined()
  })

  it('reads the verdict from the latest verification, not the agent wording', () => {
    const subject = view({
      task: { id: 'task1', goalId: 'g1', title: 't', status: 'completed', description: '' },
      executions: [{ id: 'exe1', status: 'completed', attempt: 1 }],
      verifications: [
        {
          id: 'v1',
          executionId: 'exe1',
          verdict: 'fail',
          checks: [{ checkId: 'c1', kind: 'test:unit', passed: false, command: 'pnpm test:unit', exitCode: 1, outputRef: 'artifacts/test.log' }],
        },
      ],
    })
    expect(taskPhase(subject, 0)).toBe('failed')
    expect(failingCheck(subject)?.command).toBe('pnpm test:unit')
    expect(failureReport(subject)).toContain('artifacts/test.log')
  })

  it('treats a pending approval as waiting even while the task says it is running', () => {
    const subject = view({
      task: { id: 'task1', goalId: 'g1', title: 't', status: 'running', description: '' },
      executions: [{ id: 'exe1', status: 'running', attempt: 1 }],
    })
    expect(taskPhase(subject, 0)).toBe('running')
    expect(taskPhase(subject, 1)).toBe('waiting')
  })

  it('keeps cancelled separate from failed', () => {
    const subject = view({
      task: { id: 'task1', goalId: 'g1', title: 't', status: 'cancelled', description: '' },
    })
    expect(taskPhase(subject, 0)).toBe('cancelled')
  })
})

describe('diffTotals', () => {
  it('sums insertions and deletions from the summary line', () => {
    expect(diffTotals(stat)).toEqual({ added: 92, removed: 34, files: 2 })
  })

  it('counts files when git only reports file count', () => {
    expect(diffTotals(' 3 files changed, 0 insertions(+), 0 deletions(-)')).toEqual({
      added: 0,
      removed: 0,
      files: 3,
    })
  })

  it('is empty for missing stats', () => {
    expect(diffTotals(undefined)).toEqual({ added: 0, removed: 0, files: 0 })
    expect(diffTotals('')).toEqual({ added: 0, removed: 0, files: 0 })
  })
})

describe('latestExecution / evidenceExecution', () => {
  const subject = view({
    executions: [
      { id: 'exe1', status: 'failed', attempt: 1, startedAt: '2026-11-27T10:00:00Z', evidence: { diff: 'old' } },
      {
        id: 'exe2',
        status: 'completed',
        attempt: 2,
        startedAt: '2026-11-27T10:03:00Z',
        evidence: { changedFiles: ['a.ts'], diffstat: stat },
      },
    ],
  })

  it('picks the newest attempt', () => {
    expect(latestExecution(subject)?.id).toBe('exe2')
  })

  it('prefers the attempt that actually carries a patch', () => {
    expect(evidenceExecution(subject)?.id).toBe('exe1')
  })
})

describe('time and agents', () => {
  const subject = view({
    executions: [
      { id: 'exe1', status: 'completed', attempt: 1, agentId: 'agent_a', startedAt: '2026-11-27T10:00:00Z', finishedAt: '2026-11-27T10:02:00Z' },
      { id: 'exe2', status: 'completed', attempt: 2, agentId: 'agent_b', startedAt: '2026-11-27T10:03:00Z', finishedAt: '2026-11-27T10:03:30Z' },
    ],
  })

  it('measures one attempt from its own start and finish', () => {
    expect(attemptMs(subject.executions[0])).toBe(120_000)
  })

  it('measures the run from the first start to the last finish', () => {
    expect(elapsedMs(subject)).toBe(210_000)
  })

  it('will not report a partial elapsed time when nothing finished', () => {
    const running = view({ executions: [{ id: 'exe1', status: 'running', attempt: 1, startedAt: '2026-11-27T10:00:00Z' }] })
    expect(elapsedMs(running)).toBeUndefined()
  })

  it('lists each agent once', () => {
    expect(executionAgents(subject)).toEqual(['agent_a', 'agent_b'])
    expect(executionAgents(view())).toEqual([])
  })
})
