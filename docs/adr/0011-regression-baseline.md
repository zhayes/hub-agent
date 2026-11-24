# ADR 0011：回归基线默认 mock 模式，指标只度量可复现链路

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §19.1；ARCHITECTURE §15；PLAN M10
- **证据：** `fixtures/regression-tasks`、`packages/hub/src/bench`、`reports/baseline.json`

---

## 1. 背景

M10 要求“把多 Agent 更好从主张变成数据”。但仓库里没有稳定的真实 harness 账号/网络环境；如果默认 bench 依赖真实 LLM，CI 会不稳定，指标也无法复现。

同时，不能把“mock agent 跑通”说成“LLM 规划质量更好”。

## 2. 决策

1. **mock 基线 24 条**在 `fixtures/regression-tasks`；**真实基线 27 条**（24 正例 + 3 负例）在 `fixtures/regression-tasks-real`。
2. **默认 bench 用确定性 mock ACP agent**；`--agent-command` 可跑真实 harness。报告显式写 `mode`，真实结果存 `benchmarks/real-dsh-expanded.json`。
3. **指标公式固定在 `bench/metrics.ts`**：自主完成率、验收误判率、恢复成功率、过度拆解率、Brain 决策数、人工介入次数、平均耗时。
4. **恢复成功率来自确定性恢复探针**：seed running Execution → `scanRecovery`，验证 unknown + 决策点；不是从 mock 任务伪造。
5. **真实 harness 通过 `--agent-command` 接入**；任务是否完成仍只由 `checks` 判定。
6. 报告中保留 `records` 明细，任何指标都能回溯到具体任务。

## 3. 后果

### 正面

- `pnpm bench` 可在 CI/本机稳定复现，不依赖 API key。
- 指标口径可审计；负例会暴露“假通过”。
- 真实 harness 接入不需要改 bench 主流程。

### 负面（已接受）

- 默认基线不能证明 LLM 规划质量，也不能证明“多 Agent 比单 Agent 更好”。
- 24 个描述符是回归链路基线，不是 24 个真实仓库 PR。
- `recoverySuccessRate` 是探针口径，不是生产历史恢复率。

## 4. 复审触发条件

1. 有可用真实 harness 与稳定 repo 样本；
2. M11 需要跨任务历史指标；
3. 指标公式与 PRD §19.1 出现偏差；
4. 负例被 mock 掩盖，需要更强的故障注入。
