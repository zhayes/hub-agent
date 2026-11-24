# ADR 0014：Selection Engine 用确定性打分，不硬编码 Agent

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §6.6；ARCHITECTURE §6；PLAN M8
- **证据：** `selection.test.ts`、`brain-run.test.ts`（自动换 Agent）

---

## 1. 背景

自动重试到了“换 Agent”阈值时，不能随机挑一个，也不能永远用第一个。需要可解释、可重放的选人规则。

## 2. 决策

1. 过滤 `offline` / `error` 和显式排除的 Agent。
2. 评分：历史成功率 × 100 + 状态分 + capability 匹配分 − 活跃负载 × 15。
3. 无历史按 0.5；capability 未声明不硬拒绝，只降低匹配分。
4. 同分按 `agent.id` 排序，保证确定性。
5. `runAcpWithRetry` 在 switch_agent 动作时调用 Selection Engine；没有候选则收敛失败并写 `DecisionRecord`。

## 3. 后果

- 自动换 Agent 可解释、可重放。
- 没有真实能力声明时，选人质量仍依赖历史成功率；后续接 capability/health 数据可改进。
- 重规划仍未自动创建新计划，属于下一步。
