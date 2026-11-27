import type { DomainState } from '../../domain/machine'

export interface AgentOutputSegment {
  /** 子任务标题（用作段落小标题）；子任务已被清理时退回 Agent 名。 */
  title?: string
  text: string
  agentName: string
  taskId?: string
}

/**
 * 把本 goal 下“每个成功执行的最终回答”收成一段，带 Agent 归属。
 *
 * 为什么按执行分而不是按 delta 累加：一次对话里可能派给多个 Agent
 * （workbuddy + dsh），delta 流是共享的，累加会把两份输出拧成一条无归属的
 * 长文，超过展示上限还会被静默砍尾。
 */
export function collectAgentOutputs(
  state: DomainState,
  goalId: string,
  agentNames: ReadonlyMap<string, string>,
): AgentOutputSegment[] {
  return Object.values(state.executions)
    .filter((execution) => state.tasks[execution.taskId]?.goalId === goalId)
    .filter((execution) => execution.status === 'succeeded')
    .filter((execution) => (execution.evidence?.result ?? '').trim().length > 0)
    .sort(
      (a, b) =>
        (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .map((execution) => {
      const subtask = state.subtasks[execution.subtaskId]
      const agentName = agentNames.get(String(execution.agentId)) ?? 'agent'
      return {
        title: subtask?.title ?? agentName,
        text: execution.evidence?.result ?? '',
        agentName,
        taskId: String(execution.taskId),
      }
    })
}
