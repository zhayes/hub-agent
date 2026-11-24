# ADR 0010：unknown 不重试，失败按升级链收敛

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §15.1–§15.3；ARCHITECTURE §6.7；PLAN M8
- **证据：** `escalation.test.ts`、`no-progress.test.ts`、`idempotency.test.ts`、`recovery.test.ts`、`side-effect.test.ts`

---

## 1. 背景

失败恢复最危险的捷径是“未知即重试”：进程被杀、连接中断、自述成功但无证据时，重试可能重复产生副作用。M8 必须让失败有确定的收敛路径，并保证重启后不丢现场。

## 2. 决策

1. **先分类再决定**：`protocol/startup/execution/unknown/permission/resource_conflict/provider_rate_limit/sandbox_denied` 分别处理。
2. **unknown 不直接重试**：先核验副作用（diff + 检查）；通过 → 按成功收尾；部分变更 → Brain 决定；无法判定 → 保持 unknown + 暂停等用户。
3. **升级链**：协议/启动重试最多 2 次；无副作用执行失败同 Agent 重试；同一 Subtask 连续失败 2 次换 Agent；换 Agent 后重规划最多 2 次；再问用户。
4. **sandbox_denied 不计失败**：走 Approval，不静默重试。
5. **provider_rate_limit 不计失败**：指数退避，最多 2 次。
6. **无进展不是“再等等”**：事件超时、等价计划、diff 震荡、预算异常、重复工具调用命中即决策点/暂停。
7. **幂等键由 Runtime 派生**：`goalId | subtaskId | attempt | intentKey?`，`delegation_contracts.idempotency_key UNIQUE` 原子去重。
8. **重启扫描**：非终态 Execution 进程不存在 → `unknown`，写恢复决策点；不直接 failed，也不直接重试。

## 3. 后果

### 正面

- 失败路径可预测、可审计；Agent 被反复杀死不会清零重试次数。
- 重复投递不会产生第二个 Execution。
- 重启后现场保留，用户可以决定继续/回滚/放弃。

### 负面（已接受）

- M8 的升级链目前是判定库，`runAcpTask` 尚未自动执行完整重试循环；`task pause/resume/retry` CLI 在 M9 接线。
- 无进展检测需要 Runtime 喂事件时间、计划 hash、diff hash、工具调用；目前只提供纯函数，调度接线在 M9/M10。
- `unknown` 会占用现场直到用户决策，需要 `task clean` 或恢复操作释放。

## 4. 复审触发条件

1. M9 接自动重试循环与 CLI；
2. M10 回归基线需要真实失败注入；
3. 真实 harness 的 429/超时行为与分类不一致；
4. 多 Agent 并行下同一 Subtask 的失败计数口径需要调整。
