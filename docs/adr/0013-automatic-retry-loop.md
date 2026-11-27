# ADR 0013：自动重试只覆盖可安全重试的失败

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §15.1–§15.2；ARCHITECTURE §6.7；PLAN M8
- **证据：** `brain-run.test.ts`（首次 refusal → 重试成功 / 持续失败只重试一次）、`acp-retry.test.ts`（output_limit 抬额度重试一次）、`acp-client.test.ts`（退出原因进错误）

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
8. **进程输出超限（`output_limit`）算“可安全重试”**：AgentHost 的 stdout/stderr 缓冲被杀掉进程，不代表任务本身失败。
   - 先说根因：长驻 ACP Agent 用 `outputRetention: 'bounded'`（只留头尾），**累计输出多不再杀进程**，所以这条规则现在只覆盖“单条消息异常超长”（>4 MB）这种病态情况；`full` 模式（短命令）仍按字节上限杀。
   - 策略：**重试 1 次，尽量换个 Agent**；`full` 模式下额外抬额度（stdout ×4、stderr ×2）。
   - 这一条不适用于“有 diff”的判定：超限时进程已死，本轮证据由 Runtime 重新采集，不采信 Agent 自述。
   - 既有判据“已有任务记录就不重试”把“可能有副作用”和“有记录”混为一谈，已拆开：只有 diff/审批/人工输入才拦；重试沿用原 Task/Subtask，避免旧任务停在 running。
9. **每次失败的死因要透传**：`AcpClient` 把进程退出原因（`exited` / `output_limit` / `*_timeout` / `canceled`）写进错误 `details.exitReason` 与 message，上层不再只能看到“ACP 进程已退出”。

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
