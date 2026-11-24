# ADR 0013：自动重试只覆盖可安全重试的失败

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §15.1–§15.2；ARCHITECTURE §6.7；PLAN M8
- **证据：** `brain-run.test.ts`（首次 refusal → 重试成功 / 持续失败只重试一次）

---

## 1. 背景

M8 已有升级链判定库，但 `runAcpTask` 仍在第一次失败时直接把 Subtask/Task/Goal 置 failed，等于没有自动重试。需要把“可安全重试”的部分接进执行路径，同时避免重复副作用。

## 2. 决策

1. **协议/启动失败**（尚未创建 Task/Execution）：Runtime 重试最多 2 次，指数退避。
2. **执行失败且无 diff**：同 Agent 重试 1 次；第二次失败进入“换 Agent”阈值，但 M8 没有 Selection Engine，直接收敛失败并记录原因。
3. **有 diff / 审批 / 人工输入**：不自动重试；保留现场，交 Brain/用户。
4. **失败期间不提前收敛**：`runAcpTask` 以 `retryOnFailure` 保留 subtask/task 为 running；只有重试耗尽才 `failTask` 把 subtask/task/goal 置 failed。
5. **每次升级写 DecisionRecord**：`retry` / `abort`，包含 attempt、executionId、verdict、changedFiles、原因。
6. **sandbox_denied / manual_required 不走重试**：分别走 Approval / waiting_input。
7. **不伪造换 Agent/重规划**：没有 Selection Engine 时不假装做了。

## 3. 后果

### 正面

- 无副作用失败可以被自动吸收，减少人工收尾。
- 有副作用失败不会被“重试”掩盖，避免重复写入。
- 重试历史与原因可查。

### 负面（已接受）

- 换 Agent 与自动重规划已接；CLI `task retry` 对 failed 任务创建新 attempt（新 Goal/Task）并执行。
- `task retry` 仍只支持 paused 任务 resume；失败任务无法从 CLI 自动重跑。
- 重试仍然复用同一 worktree；有 diff 时不会自动回滚。

## 4. 复审触发条件

1. Selection Engine 可用，接换 Agent；
2. M9/M11 需要 `task retry` 失败任务重跑；
3. 需要基于 diff 的自动回滚/重做；
4. 真实 harness 的重试成本需要预算控制。
