import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTaskBrief } from '../adapters/acp/brief'
import { AcpClient } from '../adapters/acp/client'
import type { AcpExecutionEvent } from '../adapters/acp/event'
import { collectGitEvidence, type GitEvidence, readGitHead } from '../adapters/acp/git-evidence'
import { AgentHost } from '../agent-host/agent-host'
import type { AgentTimeouts } from '../agent-host/types'
import type { ExecutionEvidence, TaskBrief } from '../domain/entities'
import type { DomainEvent } from '../domain/events'
import {
  asAgentId,
  asExecutionId,
  asGoalId,
  asSessionId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  type ExecutionId,
  type GoalId,
  type SubtaskId,
  type TaskId,
} from '../domain/ids'
import type { DomainState } from '../domain/machine'
import type { SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import { hubDir } from '../shared/paths'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { type AgentRecord, markAgentSeen } from './agent-registry'

/**
 * M4 的固定脚本闭环：一个 Agent、一个 Subtask、一次 prompt，不接 Brain。
 *
 * 关键顺序：
 *   1. 先启动 ACP / initialize / session/new；
 *   2. 成功后才写 Goal/Task/Subtask/Execution（拒绝启动不写任务记录）；
 *   3. prompt 结束并采集 git 证据后，先写 evidence，再把 Execution 置 succeeded
 *      （不变量 I3：没有证据不得成功）；
 *   4. Subtask/Task 不在这里置 succeeded——那需要 M5 的验收证据链。
 */

export interface RunAcpTaskOptions {
  db: Db
  provider: SandboxProvider
  agent: AgentRecord
  objective: string
  worktree: string
  transcriptDir?: string
  /** 传给沙箱的 per-command 域名白名单（模型 API 等） */
  allowedDomains?: readonly string[]
  /** 传给沙箱的 per-command 写路径（harness 自身状态目录等） */
  allowedWrite?: readonly string[]
  clientVersion?: string
  agentTimeouts?: Partial<AgentTimeouts>
  initializeTimeoutMs?: number
  promptTimeoutMs?: number
  onEvent?: (event: AcpExecutionEvent) => void
  onStderr?: (line: string) => void
}

export interface RunAcpTaskResult {
  ok: boolean
  goalId: string
  taskId: string
  subtaskId: string
  executionId: string
  sessionId: string
  agent: { id: string; name: string }
  stopReason: string
  evidence: ExecutionEvidence
  transcriptRef: string
  updates: number
  durationMs: number
}

interface CreatedIds {
  goalId: GoalId
  taskId: TaskId
  subtaskId: SubtaskId
  executionId: ExecutionId
}

function asRunError(error: unknown, ids: Partial<CreatedIds>, transcriptRef?: string): HubError {
  if (error instanceof HubError) {
    return new HubError(error.code, error.message, {
      ...(typeof error.details === 'object' && error.details !== null ? error.details : {}),
      ...ids,
      ...(transcriptRef === undefined ? {} : { transcriptRef }),
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new HubError('AGENT_HOST_FAILED', `ACP 任务执行失败：${message}`, {
    ...ids,
    ...(transcriptRef === undefined ? {} : { transcriptRef }),
  })
}

export async function runAcpTask(options: RunAcpTaskOptions): Promise<RunAcpTaskResult> {
  const startedAt = Date.now()
  const { db, provider, agent, objective, worktree } = options

  let state: DomainState = loadState(db)
  const append = (event: DomainEvent): void => {
    state = appendEvent(db, state, event).state
  }

  const ids: Partial<CreatedIds> = {}
  let transcriptRef: string | undefined
  let acp: AcpClient | undefined
  let baseSha: string | undefined
  const events: AcpExecutionEvent[] = []

  const recordEvent = (event: AcpExecutionEvent): void => {
    events.push(event)
    options.onEvent?.(event)
    if (transcriptRef !== undefined) {
      appendFileSync(
        transcriptRef,
        `${JSON.stringify({ type: 'acp.event', at: new Date().toISOString(), event })}\n`,
      )
    }
  }

  const host = new AgentHost({
    provider,
    ...(options.agentTimeouts === undefined ? {} : { timeouts: options.agentTimeouts }),
  })

  try {
    const agentProcess = await host.spawn(`acp-${newId()}`, {
      worktree,
      command: agent.command,
      // cwd 由 AgentHost 强制；写授权包含 worktree。
      sandbox: {
        allowedWrite: options.allowedWrite ?? [],
        allowedDomains: options.allowedDomains ?? [],
      },
    })

    acp = new AcpClient({
      process: agentProcess,
      version: options.clientVersion ?? '0.0.0-m4',
      onEvent: recordEvent,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.initializeTimeoutMs === undefined
        ? {}
        : { initializeTimeoutMs: options.initializeTimeoutMs }),
      ...(options.promptTimeoutMs === undefined
        ? {}
        : { promptTimeoutMs: options.promptTimeoutMs }),
    })

    const initialized = await acp.start()
    try {
      markAgentSeen(db, agent.id, {
        ...(initialized.agentCapabilities === undefined
          ? {}
          : { capabilities: initialized.agentCapabilities }),
        status: 'online',
      })
    } catch {
      // 注册表元数据不是任务成功条件；不要让它的失败掩盖真实执行。
    }

    const session = await acp.newSession(worktree)
    baseSha = await readGitHead(host, worktree).catch(() => undefined)

    const now = asTimestamp(new Date().toISOString())
    const goalId = asGoalId(newId())
    const taskId = asTaskId(newId())
    const subtaskId = asSubtaskId(newId())
    const executionId = asExecutionId(newId())
    ids.goalId = goalId
    ids.taskId = taskId
    ids.subtaskId = subtaskId
    ids.executionId = executionId

    const transcriptDir = options.transcriptDir ?? join(hubDir(), 'transcripts')
    mkdirSync(transcriptDir, { recursive: true })
    transcriptRef = join(transcriptDir, `${executionId}.jsonl`)
    const header = {
      type: 'run.started',
      at: new Date().toISOString(),
      goalId,
      taskId,
      subtaskId,
      executionId,
      sessionId: session.sessionId,
      agent: { id: agent.id, name: agent.name },
      objective,
      worktree,
      baseSha: baseSha ?? null,
    }
    writeFileSync(
      transcriptRef,
      `${[
        JSON.stringify(header),
        ...events.map((event) =>
          JSON.stringify({ type: 'acp.event', at: new Date().toISOString(), event }),
        ),
      ].join('\n')}\n`,
      'utf8',
    )

    const title = objective.length > 80 ? `${objective.slice(0, 77)}...` : objective
    append({
      type: 'goal.created',
      goal: {
        id: goalId,
        userId: 'local',
        title,
        intent: objective,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    })
    append({
      type: 'task.created',
      task: {
        id: taskId,
        goalId,
        title,
        description: objective,
        status: 'draft',
        priority: 0,
        acceptanceCriteria: ['执行完成并产出可核验的 diff'],
        createdAt: now,
        updatedAt: now,
      },
    })
    append({
      type: 'subtask.created',
      subtask: {
        id: subtaskId,
        taskId,
        title: '执行 ACP 任务',
        description: objective,
        status: 'ready',
        required: true,
        dependencies: [],
        requiredCapabilities: [],
        assignedAgentId: asAgentId(agent.id),
        priority: 0,
        maxAttempts: 1,
        createdAt: now,
        updatedAt: now,
      },
    })
    append({
      type: 'execution.created',
      execution: {
        id: executionId,
        taskId,
        subtaskId,
        agentId: asAgentId(agent.id),
        sessionId: asSessionId(session.sessionId),
        status: 'created',
        attempt: 1,
        createdAt: now,
      },
    })

    const at = (): ReturnType<typeof asTimestamp> => asTimestamp(new Date().toISOString())
    append({ type: 'task.status', taskId, to: 'planning', at: at() })
    append({ type: 'task.status', taskId, to: 'ready', at: at() })
    append({ type: 'task.status', taskId, to: 'running', at: at() })
    append({ type: 'subtask.status', subtaskId, to: 'assigned', at: at() })
    append({ type: 'subtask.status', subtaskId, to: 'running', at: at() })
    append({ type: 'execution.status', executionId, to: 'starting', at: at() })
    append({ type: 'execution.status', executionId, to: 'running', at: at() })

    const brief: TaskBrief = {
      objective,
      constraints: [
        '只修改当前任务工作区（worktree）内的文件',
        '不要读取凭据目录，不要访问白名单之外的网络',
      ],
      contextRefs: [],
      existingConventions: [],
      acceptance: ['完成后说明改了什么；最终判定由 Runtime 的验收检查给出，不采信自述'],
      outOfScope: [],
      knownPitfalls: [],
    }

    const promptResponse = await acp.prompt(renderTaskBrief(brief))
    const git = await collectGitEvidence(host, worktree, baseSha).catch((): GitEvidence => ({}))
    const evidence: ExecutionEvidence = {
      ...git,
      transcriptRef,
    }

    append({ type: 'execution.evidence', executionId, evidence })

    const succeeded = promptResponse.stopReason === 'end_turn'
    if (succeeded) {
      append({ type: 'execution.status', executionId, to: 'succeeded', at: at() })
    } else {
      append({ type: 'execution.status', executionId, to: 'failed', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'failed', at: at() })
      append({ type: 'task.status', taskId, to: 'failed', at: at() })
      append({ type: 'goal.status', goalId, to: 'failed', at: at() })
    }

    return {
      ok: succeeded,
      goalId,
      taskId,
      subtaskId,
      executionId,
      sessionId: session.sessionId,
      agent: { id: agent.id, name: agent.name },
      stopReason: promptResponse.stopReason,
      evidence,
      transcriptRef,
      updates: events.length,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    // 只有 ACP 成功建 Session 后才可能已经有记录；此时把失败收敛到执行上。
    if (ids.executionId !== undefined && ids.taskId !== undefined && ids.subtaskId !== undefined) {
      try {
        const git = await collectGitEvidence(host, worktree, baseSha).catch((): GitEvidence => ({}))
        const evidence: ExecutionEvidence = {
          ...git,
          ...(transcriptRef === undefined ? {} : { transcriptRef }),
        }
        append({ type: 'execution.evidence', executionId: ids.executionId, evidence })
        append({
          type: 'execution.status',
          executionId: ids.executionId,
          to: 'failed',
          at: asTimestamp(new Date().toISOString()),
        })
        append({
          type: 'subtask.status',
          subtaskId: ids.subtaskId,
          to: 'failed',
          at: asTimestamp(new Date().toISOString()),
        })
        append({
          type: 'task.status',
          taskId: ids.taskId,
          to: 'failed',
          at: asTimestamp(new Date().toISOString()),
        })
        if (ids.goalId !== undefined) {
          append({
            type: 'goal.status',
            goalId: ids.goalId,
            to: 'failed',
            at: asTimestamp(new Date().toISOString()),
          })
        }
      } catch {
        // 失败路径的记录是尽力而为；原始错误仍必须上抛。
      }
    }
    throw asRunError(error, ids, transcriptRef)
  } finally {
    await acp?.dispose().catch(() => undefined)
    await host.dispose().catch(() => undefined)
  }
}
