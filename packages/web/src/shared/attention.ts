import type { ApprovalRow, TaskRow } from './api'

/**
 * 「需要你」的唯一派生源（PLAN-CONSOLE-INTERACTION §2.3、ADR 0029 §2.2）。
 *
 * 指示器、浮层队列、线程抽屉上的计数都从这里取，避免三处各算一遍再对不上。
 * 目前只认两种事实：待批的审批、停在「等你输入」的任务。
 * 精确的“谁等得最久”需要后端给时间戳（决策 D 待定），所以这里保持后端顺序，
 * 只把审批排在任务前面——审批是阻塞中的阻塞。
 */

export type AttentionKind = 'approval' | 'input'

export interface AttentionItem {
  /** `kind:id`，可直接做列表 key。 */
  id: string
  kind: AttentionKind
  taskId?: string
  approvalId?: string
  /** 要你做什么，一句话。 */
  title: string
  /** 具体对象：命令 / 资源路径。只给能核对的，不编。 */
  resource?: string
  risk?: string
  /** 领域动作名（如 `sandbox.relax`）；决定标题与按钮怎么说。 */
  action?: string
  decisionMode?: 'once' | 'policy'
  /** 审批的 TTL。 */
  expiresAt?: string
  /** 在哪个任务里发生的。 */
  taskTitle?: string
}

export interface AttentionSource {
  approvals: readonly ApprovalRow[]
  tasks: readonly TaskRow[]
}

export function deriveAttention(source: AttentionSource): AttentionItem[] {
  const items: AttentionItem[] = []
  const titleOf = (taskId: string): string | undefined =>
    source.tasks.find((task) => task.id === taskId)?.title

  for (const approval of source.approvals) {
    if (approval.status !== 'pending') continue
    const taskTitle = titleOf(approval.taskId)
    items.push({
      id: `approval:${approval.id}`,
      kind: 'approval',
      taskId: approval.taskId,
      approvalId: approval.id,
      title: approval.reason,
      resource: approval.resource,
      risk: approval.riskLevel,
      ...(approval.action === undefined ? {} : { action: approval.action }),
      ...(approval.decisionMode === undefined ? {} : { decisionMode: approval.decisionMode }),
      ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
      ...(taskTitle === undefined ? {} : { taskTitle }),
    })
  }

  for (const task of source.tasks) {
    if (task.status !== 'waiting_input') continue
    const hasApproval = items.some((item) => item.taskId === task.id)
    if (hasApproval) continue
    items.push({
      id: `input:${task.id}`,
      kind: 'input',
      taskId: task.id,
      title: task.title,
    })
  }

  return items
}
