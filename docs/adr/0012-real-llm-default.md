# ADR 0012：默认真实 LLM Brain，ScriptedBrain 只做测试替身

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §6.10；ARCHITECTURE §5；PLAN M6
- **证据：** `llm-brain.test.ts`、`brain-run.test.ts`、`pnpm test:brain-real`

---

## 1. 背景

M6 先用 `ScriptedBrain` 把快照、队列、校验、预算、DecisionRecord 管道钉死。它是测试替身，不是产品 Brain；但默认使用它会让 `hubagent run` 看起来有 Brain、实际没有模型决策。

## 2. 决策

1. **默认 `HUBAGENT_BRAIN_MODE=llm`**：`run` 默认走真实 OpenAI-compatible 模型。
2. **无 key fail-closed**：缺少 `HUBAGENT_BRAIN_API_KEY` 时明确报错，不静默退回 scripted。
3. **`scripted` 只显式启用**：用于 CI、离线、排障；不再作为默认产品路径。
4. **实现位置**：`brain/pi/{llm-client,llm-brain}.ts` + `brain/create-brain.ts`；Runtime 只依赖 `brain/create-brain`（满足 R3）。
5. **模型输出仍由 Runtime 校验**：schema/权限/预算/幂等不因为换成真实模型而放宽。
6. **真实 key smoke**：`pnpm test:brain-real`；没有 key 时 SKIP，不伪造通过。

## 3. 后果

### 正面

- `run` 默认是真实模型决策，不再把测试替身当产品。
- 无 key 时行为明确，用户不会误以为 Brain 在工作。
- CI 仍可用显式 `scripted` 保持确定性。

### 负面（已接受）

- 本地开发必须配置 key，否则 `run` 失败；这是刻意的 fail-closed。
- 当前是 OpenAI-compatible 适配器，不是 Pi SDK 集成。
- `runGoalWithBrain` 仍只执行 `revise_plan` 的第一个子任务；多子任务执行器未完成。

## 4. 复审触发条件

1. 接入 Pi SDK 或第二个模型 provider；
2. 多子任务执行器完成，允许真实 Brain 拆多个子任务；
3. 模型输出稳定性/成本需要缓存或降级策略；
4. 用户需要无 key 的完全离线模式。
