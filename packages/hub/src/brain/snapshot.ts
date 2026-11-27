import type { ExecutionEvidence } from '../domain/entities'
import type { DomainState } from '../domain/machine'
import type {
  AgentSummary,
  BrainBudget,
  BrainInput,
  ChatTurn,
  ExecutionView,
  PendingDecisionView,
  RemotePeerSummary,
  SubtaskView,
  TaskView,
} from './types'

export interface BuildBrainInputOptions {
  state: DomainState
  goalId: string
  agents: readonly AgentSummary[]
  /** 会话工作区；Brain 据此判断“当前项目”是哪个目录。 */
  workspace?: string
  /** 可委托的远程对端；未配置时快照不带 `peers` 字段。 */
  peers?: readonly RemotePeerSummary[]
  pending: readonly PendingDecisionView[]
  budget: BrainBudget
  stateVersion: number
  planRevision?: number
  /** 控制台对话历史；没有对话入口时省略。 */
  conversation?: readonly ChatTurn[]
}

/**
 * 把 DomainState 折叠成 Brain 可读快照。
 *
 * 明确不包含：原始事件流、工具调用流水、完整日志。
 * 只给目标、计划、子任务状态、证据摘要、验收结论、待决事项与预算。
 */
export function buildBrainInput(options: BuildBrainInputOptions): BrainInput {
  const goal = options.state.goals[options.goalId]
  if (goal === undefined) {
    throw new Error(`goal 不存在：${options.goalId}`)
  }

  const tasks = Object.values(options.state.tasks)
    .filter((task) => task.goalId === goal.id)
    .sort((a, b) => a.id.localeCompare(b.id))

  const taskViews: TaskView[] = tasks.map((task) => {
    const subtasks = Object.values(options.state.subtasks)
      .filter((subtask) => subtask.taskId === task.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((subtask): SubtaskView => {
        const executions = Object.values(options.state.executions)
          .filter((execution) => execution.subtaskId === subtask.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        const latest = executions[executions.length - 1]
        if (latest === undefined) {
          return {
            id: subtask.id,
            title: subtask.title,
            description: subtask.description,
            status: subtask.status,
            required: subtask.required,
          }
        }
        const verification = Object.values(options.state.verifications)
          .filter((run) => run.executionId === latest.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .at(-1)
        return {
          id: subtask.id,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
          required: subtask.required,
          execution: {
            id: latest.id,
            status: latest.status,
            ...(latest.sessionId === undefined ? {} : { sessionId: latest.sessionId }),
            ...(latest.evidence === undefined ? {} : { evidence: evidenceView(latest.evidence) }),
            ...(verification === undefined
              ? {}
              : { verification: { verdict: verification.verdict } }),
          },
        }
      })

    return { id: task.id, title: task.title, status: task.status, subtasks }
  })

  const taskGoal = new Map(tasks.map((task) => [task.id, task.goalId]))
  const approvals = Object.values(options.state.approvals)
    .filter((approval) => taskGoal.get(approval.taskId) === goal.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((approval) => ({
      id: approval.id,
      status: approval.status,
      reason: approval.reason,
      resource: approval.resource,
    }))

  const conversation = options.conversation?.filter((turn) => turn.content.trim() !== '')
  const peers = options.peers ?? []

  return {
    goal: {
      id: goal.id,
      title: goal.title,
      intent: goal.intent,
      status: goal.status,
    },
    ...(options.workspace === undefined ? {} : { workspace: { path: options.workspace } }),
    ...(conversation === undefined || conversation.length === 0
      ? {}
      : { conversation: [...conversation] }),
    planRevision: options.planRevision ?? 1,
    tasks: taskViews,
    agents: [...options.agents].sort((a, b) => a.id.localeCompare(b.id)),
    ...(peers.length === 0 ? {} : { peers: [...peers].sort((a, b) => a.id.localeCompare(b.id)) }),
    pending: [...options.pending].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    ),
    approvals,
    budget: { ...options.budget },
    stateVersion: options.stateVersion,
  }
}

/**
 * 快照里给 Brain 看的证据视图。
 *
 * `evidence.result` 是 Agent 的最终回答，可能有上万字；整段塞进快照会把
 * 上下文预算吃掉。这里按固定上限截断并显式标记，让 Brain 知道“还有更多”。
 */
const BRAIN_RESULT_CHARS = 4_000

function evidenceView(evidence: NonNullable<ExecutionEvidence>): ExecutionView['evidence'] {
  const result = evidence.result
  const truncated = result !== undefined && result.length > BRAIN_RESULT_CHARS
  return {
    ...(evidence.branch === undefined ? {} : { branch: evidence.branch }),
    ...(evidence.commitSha === undefined ? {} : { commitSha: evidence.commitSha }),
    ...(evidence.diffstat === undefined ? {} : { diffstat: evidence.diffstat }),
    ...(evidence.changedFiles === undefined ? {} : { changedFiles: evidence.changedFiles }),
    ...(evidence.transcriptRef === undefined ? {} : { transcriptRef: evidence.transcriptRef }),
    ...(result === undefined
      ? {}
      : {
          result: truncated
            ? `${result.slice(0, BRAIN_RESULT_CHARS)}\n…（已截断，原文共 ${result.length} 字）`
            : result,
        }),
    ...(truncated ? { resultTruncated: true } : {}),
  }
}
