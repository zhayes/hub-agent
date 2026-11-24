import type {
  BrainAction,
  BrainInput,
  DecisionRationale,
  OrchestratorBrain,
  SubtaskView,
} from './types'

/**
 * M6 的确定性 Brain：用固定规则证明“快照 → 动作 → 记录”可重放。
 *
 * 它不是 LLM；Pi 适配器可以替换它，而不改 Runtime/队列/校验。
 * 规则：
 *   - 没有计划 → 拆一个子任务；
 *   - 有 ready 子任务 → 委派给第一个可用 Agent；
 *   - 子任务 succeeded + 验收 pass → accept + finish；
 *   - 子任务 failed → reject(next=retry)；
 *   - 等待审批/输入 → request_human。
 */
export class ScriptedBrain implements OrchestratorBrain {
  async step(input: BrainInput): Promise<BrainAction[]> {
    const subtasks = flatten(input)
    if (subtasks.length === 0) {
      return [
        {
          type: 'revise_plan',
          subtasks: [
            {
              title: input.goal.title,
              description: input.goal.intent,
              requiredCapabilities: [],
              maxAttempts: 1,
            },
          ],
          reason: 'M6 固定单子任务：先证明快照与决策可重放',
        },
      ]
    }

    const waiting = subtasks.find(
      (subtask) => subtask.status === 'waiting_approval' || subtask.status === 'waiting_input',
    )
    if (waiting !== undefined) {
      return [
        {
          type: 'request_human',
          question: `子任务 ${waiting.id} 正在等待用户输入或审批`,
          ...(waiting.execution === undefined ? {} : { executionId: waiting.execution.id }),
        },
      ]
    }

    const ready = subtasks.find((subtask) => subtask.status === 'ready')
    if (ready !== undefined) {
      const agent = input.agents.find(
        (candidate) => candidate.status !== 'offline' && candidate.status !== 'error',
      )
      if (agent === undefined) {
        return [
          {
            type: 'request_human',
            question: '没有可用的本地 Agent，无法委派任务',
            options: ['注册 Agent 后重试'],
          },
        ]
      }
      return [
        {
          type: 'delegate',
          request: {
            subtaskId: ready.id,
            objective: ready.description,
            agentId: agent.id,
          },
        },
      ]
    }

    const succeeded = subtasks.filter(
      (subtask) =>
        subtask.status === 'succeeded' && subtask.execution?.verification?.verdict === 'pass',
    )
    if (succeeded.length === subtasks.filter((subtask) => subtask.required).length) {
      return [
        ...succeeded.map(
          (subtask): BrainAction => ({
            type: 'accept',
            subtaskId: subtask.id,
            rationale: `子任务 ${subtask.id} 的执行有验收证据`,
          }),
        ),
        { type: 'finish', summary: `目标 ${input.goal.title} 的子任务均通过验收` },
      ]
    }

    const failed = subtasks.find((subtask) => subtask.status === 'failed')
    if (failed !== undefined) {
      return [
        {
          type: 'reject',
          subtaskId: failed.id,
          reason: '子任务失败，需要重试或重规划',
          next: 'retry',
        },
      ]
    }

    return [
      {
        type: 'request_human',
        question: '当前计划没有可推进的动作，需要用户决策',
      },
    ]
  }

  async explain(input: BrainInput): Promise<DecisionRationale[]> {
    const subtasks = flatten(input)
    if (subtasks.length === 0) {
      return [
        {
          type: 'decompose',
          rationale: 'M6 固定单子任务：先证明快照与决策可重放',
          alternatives: ['拆成多个子任务', '交给 Pi 规划'],
        },
      ]
    }
    const ready = subtasks.find((subtask) => subtask.status === 'ready')
    if (ready !== undefined) {
      const agent = input.agents.find(
        (candidate) => candidate.status !== 'offline' && candidate.status !== 'error',
      )
      return [
        {
          type: 'select_agent',
          rationale:
            agent === undefined
              ? '没有可用 Agent，必须请求用户'
              : `选择第一个可用 Agent：${agent.name}`,
          alternatives: input.agents
            .filter((candidate) => candidate.id !== agent?.id)
            .map((candidate) => candidate.name),
        },
      ]
    }
    return [
      {
        type: 'accept_result',
        rationale: '按子任务状态与验收结论决定下一步',
      },
    ]
  }
}

function flatten(input: BrainInput): SubtaskView[] {
  return input.tasks.flatMap((task) => task.subtasks).sort((a, b) => a.id.localeCompare(b.id))
}
