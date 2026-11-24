import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTaskBrief } from '../adapters/acp/brief'
import { AcpClient } from '../adapters/acp/client'
import type { AcpExecutionEvent } from '../adapters/acp/event'
import { collectGitEvidence, type GitEvidence, readGitHead } from '../adapters/acp/git-evidence'
import { AgentHost } from '../agent-host/agent-host'
import type { AgentTimeouts } from '../agent-host/types'
import type {
  Approval,
  ExecutionEvidence,
  TaskBrief,
  VerificationCheck,
  VerificationRun,
  VerificationVerdict,
} from '../domain/entities'
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
import type { SandboxNetworkMode, SandboxProvider } from '../sandbox/types'
import { HubError } from '../shared/errors'
import { newId } from '../shared/id'
import { hubDir } from '../shared/paths'
import type { Db } from '../storage/db'
import { loadState } from '../storage/queries/state'
import { appendEvent } from '../storage/write/events'
import { type AgentRecord, markAgentSeen } from './agent-registry'
import { createSandboxDeniedApproval } from './approval'
import { deriveIdempotencyKey, reserveDelegation } from './recovery/idempotency'
import { runVerification } from './verify/runner'

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
  /** 已有 Goal（Brain 先建目标），不传则按 M4 固定流创建 */
  goalId?: string
  /** 已有 Execution ID（worktree 租约需要先知道它），不传则新建 */
  executionId?: string
  /** 已有 Task / Subtask（并行编排先建计划），不传则新建 */
  taskId?: string
  subtaskId?: string
  idempotencyKey?: string
  /** Brain 决定的计划标题；不传用 objective 生成 */
  plan?: {
    taskTitle: string
    taskDescription: string
    subtaskTitle: string
    subtaskDescription: string
  }
  transcriptDir?: string
  /** 网络策略；默认 agent-managed（本地受信 Agent 自己负责网络） */
  networkMode?: SandboxNetworkMode
  /** 仅 allowlist 模式使用 */
  allowedDomains?: readonly string[]
  /** 传给沙箱的 per-command 写路径（harness 自身状态目录等） */
  allowedWrite?: readonly string[]
  clientVersion?: string
  agentTimeouts?: Partial<AgentTimeouts>
  initializeTimeoutMs?: number
  promptTimeoutMs?: number
  /** 可执行验收检查；空 = 无法自动判定，verdict 为 manual_required */
  checks?: readonly VerificationCheck[]
  /** 验收日志目录；默认 ~/.hubagent/artifacts/<executionId> */
  artifactDir?: string
  approvalDecisionMode?: 'once' | 'policy'
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
  verdict: VerificationVerdict | 'not_run'
  verification?: VerificationRun
  approval?: Approval
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
  const networkMode = options.networkMode ?? 'agent-managed'
  const gitSandbox = {
    networkMode,
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
  }

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
        networkMode,
        ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
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
    baseSha = await readGitHead(host, worktree, gitSandbox).catch(() => undefined)

    const now = asTimestamp(new Date().toISOString())
    const goalId = options.goalId === undefined ? asGoalId(newId()) : asGoalId(options.goalId)
    if (options.goalId !== undefined && state.goals[goalId] === undefined) {
      throw new HubError('NOT_FOUND', `Goal 不存在：${options.goalId}`, { goalId: options.goalId })
    }
    const taskId = options.taskId === undefined ? asTaskId(newId()) : asTaskId(options.taskId)
    const subtaskId =
      options.subtaskId === undefined ? asSubtaskId(newId()) : asSubtaskId(options.subtaskId)
    if (options.taskId !== undefined) {
      const existing = state.tasks[taskId]
      if (existing === undefined) {
        throw new HubError('NOT_FOUND', `Task 不存在：${options.taskId}`, {
          taskId: options.taskId,
        })
      }
      if (existing.goalId !== goalId) {
        throw new HubError('EVENT_REJECTED', 'Task 不属于指定 Goal', {
          taskId: options.taskId,
          goalId,
        })
      }
    }
    if (options.subtaskId !== undefined) {
      const existing = state.subtasks[subtaskId]
      if (existing === undefined) {
        throw new HubError('NOT_FOUND', `Subtask 不存在：${options.subtaskId}`, {
          subtaskId: options.subtaskId,
        })
      }
      if (existing.taskId !== taskId) {
        throw new HubError('EVENT_REJECTED', 'Subtask 不属于指定 Task', {
          subtaskId: options.subtaskId,
          taskId,
        })
      }
    }
    const executionId =
      options.executionId === undefined
        ? asExecutionId(newId())
        : asExecutionId(options.executionId)
    if (state.executions[executionId] !== undefined) {
      throw new HubError('EVENT_REJECTED', `Execution 已存在：${executionId}`, {
        executionId,
      })
    }
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
    if (options.goalId === undefined) {
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
    }
    if (options.taskId === undefined) {
      append({
        type: 'task.created',
        task: {
          id: taskId,
          goalId,
          title: options.plan?.taskTitle ?? title,
          description: options.plan?.taskDescription ?? objective,
          status: 'draft',
          priority: 0,
          acceptanceCriteria: ['执行完成并产出可核验的 diff'],
          createdAt: now,
          updatedAt: now,
        },
      })
    }
    if (options.subtaskId === undefined) {
      append({
        type: 'subtask.created',
        subtask: {
          id: subtaskId,
          taskId,
          title: options.plan?.subtaskTitle ?? '执行 ACP 任务',
          description: options.plan?.subtaskDescription ?? objective,
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
    }
    const idempotencyKey =
      options.idempotencyKey ?? deriveIdempotencyKey({ goalId, subtaskId, attempt: 1 })
    const reservation = reserveDelegation(db, {
      subtaskId,
      idempotencyKey,
      executionId,
      brief: { objective, worktree },
      workspace: { worktree },
      budget: { maxWallClockMs: options.promptTimeoutMs ?? 0 },
      policy: { networkMode },
    })
    if (!reservation.created && reservation.contract.executionId !== executionId) {
      throw new HubError('ACTION_REJECTED', '幂等键已绑定到另一个 Execution，拒绝重复投递', {
        idempotencyKey,
        existingExecutionId: reservation.contract.executionId,
        requestedExecutionId: executionId,
      })
    }

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
    if (options.taskId === undefined && state.tasks[taskId]?.status === 'draft') {
      append({ type: 'task.status', taskId, to: 'planning', at: at() })
      append({ type: 'task.status', taskId, to: 'ready', at: at() })
      append({ type: 'task.status', taskId, to: 'running', at: at() })
    }
    if (state.subtasks[subtaskId]?.status === 'ready') {
      append({ type: 'subtask.status', subtaskId, to: 'assigned', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'running', at: at() })
    }
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
    const git = await collectGitEvidence(host, worktree, baseSha, gitSandbox).catch(
      (): GitEvidence => ({}),
    )
    const evidence: ExecutionEvidence = {
      ...git,
      transcriptRef,
    }

    append({ type: 'execution.evidence', executionId, evidence })

    if (promptResponse.stopReason !== 'end_turn') {
      append({ type: 'execution.status', executionId, to: 'failed', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'failed', at: at() })
      append({ type: 'task.status', taskId, to: 'failed', at: at() })
      append({ type: 'goal.status', goalId, to: 'failed', at: at() })
      return {
        ok: false,
        goalId,
        taskId,
        subtaskId,
        executionId,
        sessionId: session.sessionId,
        agent: { id: agent.id, name: agent.name },
        stopReason: promptResponse.stopReason,
        verdict: 'not_run',
        evidence,
        transcriptRef,
        updates: events.length,
        durationMs: Date.now() - startedAt,
      }
    }

    const verification = await runVerification({
      executionId,
      worktree,
      checks: options.checks ?? [],
      ...(evidence.changedFiles === undefined ? {} : { changedFiles: evidence.changedFiles }),
      artifactDir: options.artifactDir ?? join(hubDir(), 'artifacts', executionId),
      host,
      networkMode,
      ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
      ...(options.allowedWrite === undefined ? {} : { allowedWrite: options.allowedWrite }),
    })
    append({ type: 'verification.recorded', run: verification.run })

    let approval: Approval | undefined
    if (verification.sandboxDenied !== undefined) {
      approval = createSandboxDeniedApproval({
        taskId,
        executionId,
        agentId: agent.id,
        source: verification.sandboxDenied.source,
        text: verification.sandboxDenied.text,
        ...(options.approvalDecisionMode === undefined
          ? {}
          : { decisionMode: options.approvalDecisionMode }),
      })
      append({ type: 'approval.requested', approval })
    }

    if (verification.run.verdict === 'pass') {
      append({ type: 'execution.status', executionId, to: 'succeeded', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'succeeded', at: at() })
      // 验收 pass 不等于交付完成（PRD §6.12.4）。Task 保持 running，
      // 等 M7 的 branch-only / patch-export 交付动作实际落地后再 completed。
    } else if (approval !== undefined) {
      append({ type: 'execution.status', executionId, to: 'waiting_permission', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'waiting_approval', at: at() })
      append({ type: 'task.status', taskId, to: 'waiting_approval', at: at() })
    } else if (verification.run.verdict === 'manual_required') {
      append({ type: 'execution.status', executionId, to: 'waiting_input', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'waiting_input', at: at() })
      append({ type: 'task.status', taskId, to: 'waiting_input', at: at() })
    } else {
      append({ type: 'execution.status', executionId, to: 'failed', at: at() })
      append({ type: 'subtask.status', subtaskId, to: 'failed', at: at() })
      append({ type: 'task.status', taskId, to: 'failed', at: at() })
      append({ type: 'goal.status', goalId, to: 'failed', at: at() })
    }

    return {
      ok: verification.run.verdict === 'pass',
      goalId,
      taskId,
      subtaskId,
      executionId,
      sessionId: session.sessionId,
      agent: { id: agent.id, name: agent.name },
      stopReason: promptResponse.stopReason,
      verdict: verification.run.verdict,
      verification: verification.run,
      ...(approval === undefined ? {} : { approval }),
      evidence,
      transcriptRef,
      updates: events.length,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    // 只有 ACP 成功建 Session 后才可能已经有记录；此时把失败收敛到执行上。
    if (ids.executionId !== undefined && ids.taskId !== undefined && ids.subtaskId !== undefined) {
      try {
        const git = await collectGitEvidence(host, worktree, baseSha, gitSandbox).catch(
          (): GitEvidence => ({}),
        )
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
