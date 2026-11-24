# ADR 0008：M6 用 ScriptedBrain 验证接口，Pi/LLM 适配器后接

- **状态：** 部分被 ADR 0012 取代（ScriptedBrain 不再是默认；仅测试/离线）
- **日期：** 2026-11-24
- **相关：** PRD §6.10 / §11.16 / §13.5.6；ARCHITECTURE §5；PLAN M6
- **证据：** `brain.test.ts`、`pi-brain.test.ts`、`runtime/brain-run.ts`

---

## 1. 背景

M6 的目标是把“做什么”从硬编码换成可替换的决策层，并证明决策可复现。V1 目标实现是 Pi Agent Runtime，但本仓库当前没有 Pi 依赖，也没有模型 provider/key 的稳定测试环境。

如果先接 LLM，会把“接口/队列/校验/预算/路由是否正确”和“模型输出是否稳定”混在一起，失败时无法定位。这与 M4 刻意不接 Brain 的理由相同。

## 2. 决策

1. **先用 `ScriptedBrain` 实现 `OrchestratorBrain`**：规则固定、无随机、无时间依赖，用来证明“同一快照 → 同一动作”。
2. **Runtime 不依赖具体 Brain**：`brain-run.ts` 只接收 `OrchestratorBrain`；替换成 Pi/LLM 不需要改队列、校验、DecisionRecord 或 CLI。
3. **决策队列、动作校验、预算、DecisionRecord、clarify/decide 路由现在就完整落地**，这些是 LLM 接入后仍然不变的部分。
4. **`hubagent run` 默认走 Brain**，`--no-brain` 保留 M4 固定脚本作为排障/对照。
5. **Pi/LLM 适配器不在 M6 伪造**：未接就是未接，PLAN 里标为已知留白；不把“脚本 Brain 跑通”说成“LLM 决策已验证”。

## 3. 后果

### 正面

- M6 的可重放性、队列并发、动作校验、预算、clarify 路由都有确定性测试。
- 接入 Pi 时只需要实现 `step/explain` 两个方法，风险被隔离在 `brain/pi/**`（R3）。
- `task decisions` 已经有真实 DecisionRecord 可看，不依赖模型。

### 负面（已接受）

- M6 还没有真实 LLM 规划质量；多子任务拆解、重规划、Agent 选择质量要等 Pi 接入后再评估。
- `ScriptedBrain` 只产出单子任务；不能拿它证明复杂计划的收益。

## 4. 复审触发条件

1. Pi/LLM provider 与 key 在本地可用；
2. M7 需要多 Agent 并行，单子任务 Brain 不够；
3. M8 需要复杂重规划/升级链；
4. 真实 harness 回归显示单子任务计划质量不足。
