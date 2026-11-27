import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAcpWithRetry } from '../../src/runtime/acp-retry'
import { addAgent, resolveAgent } from '../../src/runtime/agent-registry'
import type {
  SandboxDescription,
  SandboxedCommand,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/types'
import { HubError } from '../../src/shared/errors'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

/*
 * 只替换真正起进程的那层：重试策略本身（何时重试、额度怎么抬、什么时候认输）
 * 才是这里的被测对象。
 */
const { runAcpTaskMock } = vi.hoisted(() => ({ runAcpTaskMock: vi.fn() }))

vi.mock('../../src/runtime/acp-run', () => ({
  runAcpTask: runAcpTaskMock,
  DEFAULT_ACP_MAX_STDOUT_BYTES: 32 * 1024 * 1024,
  DEFAULT_ACP_MAX_STDERR_BYTES: 8 * 1024 * 1024,
}))

const dbs: Db[] = []

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
  runAcpTaskMock.mockReset()
})

function database(): Db {
  const db = openDatabase(':memory:')
  migrate(db)
  addAgent(db, { name: 'mock', command: 'mock-acp' })
  dbs.push(db)
  return db
}

class StubProvider implements SandboxProvider {
  describe(): SandboxDescription {
    return { kind: 'srt', platform: process.platform, ready: true, detail: 'test' }
  }

  async wrap(_command: string, _spec: SandboxSpec): Promise<SandboxedCommand> {
    return { argv: [process.execPath], env: { ...process.env } }
  }

  async dispose(): Promise<void> {}
}

function outputLimitError(): HubError {
  return new HubError('AGENT_HOST_FAILED', 'session/prompt 时 ACP 进程已退出（output_limit）', {
    label: 'session/prompt',
    taskId: 'TASK_1',
    goalId: 'GOAL_1',
    subtaskId: 'SUBTASK_1',
    executionId: 'EXEC_1',
    exitReason: 'output_limit',
  })
}

function successResult() {
  return {
    ok: true,
    goalId: 'GOAL_1',
    taskId: 'TASK_1',
    subtaskId: 'SUBTASK_1',
    executionId: 'EXEC_2',
    sessionId: 'SESSION_1',
    agent: { id: 'A1', name: 'mock' },
    stopReason: 'end_turn',
    attempt: 2,
    verdict: 'pass',
    evidence: {},
    transcriptRef: 'transcript.jsonl',
    updates: 1,
    durationMs: 1,
  }
}

function baseOptions(db: Db, retention?: 'full' | 'bounded') {
  return {
    db,
    provider: new StubProvider(),
    agent: resolveAgent(db, 'mock'),
    objective: 'review 代码',
    worktree: '/tmp/worktree',
    goalId: 'GOAL_1',
    ...(retention === undefined ? {} : { outputRetention: retention }),
  }
}

describe('runAcpWithRetry：进程输出超限', () => {
  it('第一次 output_limit 不算失败：沿用原 Task/Subtask 重试一次并成功', async () => {
    const db = database()
    runAcpTaskMock.mockRejectedValueOnce(outputLimitError()).mockResolvedValueOnce(successResult())

    const result = await runAcpWithRetry(baseOptions(db))

    expect(result.ok).toBe(true)
    expect(runAcpTaskMock).toHaveBeenCalledTimes(2)
    const second = runAcpTaskMock.mock.calls[1]?.[0] as {
      attempt: number
      taskId?: string
      subtaskId?: string
      maxStdoutBytes: number
      maxStderrBytes: number
      executionId?: string
    }
    expect(second.attempt).toBe(2)
    expect(second.executionId).toBeUndefined()
    /* 沿用原 Task/Subtask，不另开新的（否则旧任务永远停在 running）。 */
    expect(second.taskId).toBe('TASK_1')
    expect(second.subtaskId).toBe('SUBTASK_1')
  })

  it('默认 bounded 策略下不抬额度（上限本来就不参与）', async () => {
    const db = database()
    runAcpTaskMock.mockRejectedValueOnce(outputLimitError()).mockResolvedValueOnce(successResult())

    await runAcpWithRetry(baseOptions(db))

    const second = runAcpTaskMock.mock.calls[1]?.[0] as {
      maxStdoutBytes: number
      maxStderrBytes: number
    }
    expect(second.maxStdoutBytes).toBe(32 * 1024 * 1024)
    expect(second.maxStderrBytes).toBe(8 * 1024 * 1024)
  })

  it('full 策略下才会抬额度重试', async () => {
    const db = database()
    runAcpTaskMock.mockRejectedValueOnce(outputLimitError()).mockResolvedValueOnce(successResult())

    await runAcpWithRetry(baseOptions(db, 'full'))

    const second = runAcpTaskMock.mock.calls[1]?.[0] as {
      maxStdoutBytes: number
      maxStderrBytes: number
    }
    expect(second.maxStdoutBytes).toBe(32 * 1024 * 1024 * 4)
    expect(second.maxStderrBytes).toBe(8 * 1024 * 1024 * 2)
  })

  it('第二次还超限就收敛失败，不会无限重试', async () => {
    const db = database()
    runAcpTaskMock.mockRejectedValue(outputLimitError())

    await expect(runAcpWithRetry(baseOptions(db))).rejects.toBeInstanceOf(HubError)
    expect(runAcpTaskMock).toHaveBeenCalledTimes(2)

    const rows = db.prepare('SELECT type FROM decision_records').all() as unknown as {
      type: string
    }[]
    expect(rows.some((row) => row.type === 'retry')).toBe(true)
    expect(rows.some((row) => row.type === 'abort')).toBe(true)
  })
})
