# ADR 0007：验收由 Runtime 执行，自述不参与状态迁移

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §6.7.4–§6.7.6 / §11.13 / §17 TC-008、TC-009；ARCHITECTURE §6.5；PLAN M5
- **证据：** `verification.test.ts`、`acp-run.test.ts`（TC-008 / TC-009）、`pnpm hubagent task show --evidence` 实跑

---

## 1. 背景

M4 结束时，Execution 的 `succeeded` 只代表“ACP prompt 正常返回”。Agent 说“测试通过 / 已完成”不能作为判定依据：被验收方不能当自己结果的唯一验证者（PRD §6.7.4）。

M5 必须回答的是：**“完成”是不是一个可执行、可追溯的事实。**

## 2. 决策

1. **验收由 Runtime 的 Verification Runner 执行**，不调用被验收 Agent，不读取 Agent 自述作为通过条件。
2. **检查必须可执行**：`command / fileExists / diffScope / noUnexpectedChange / llmReview`；自然语言不能单独作为 pass 依据。
3. **verdict 规则**：
   - 任一确定性检查失败 → `fail`；
   - 含 `llmReview` 或没有检查 → `manual_required`；
   - 全通过才 `pass`。
4. **状态顺序**：先写 `ExecutionEvidence` + `VerificationRun`，再收敛 Execution/Subtask/Task；`pass` 才允许 `subtask.succeeded`；`task.completed` 还需要 M7 的交付动作（PRD §6.12.4），M5 不越权完成。
5. **sandbox_denied 走 Approval**：不把隔离拦截伪装成普通任务失败；生成 `reason=sandbox_denied` 的 pending Approval，任务停在 `waiting_approval`。
6. **diffScope 默认开启**；CLI 未给 `--allowed-path` 时默认 `.`，需要收紧时显式声明。
7. **llmReview 只做人工标记**，M5 不实现 LLM 评审质量优化；无法自动判定的项绝不默认通过。
8. 大输出落 artifact 文件，`VerificationCheckResult` 只存 `outputRef`，不把日志内联进事件/数据库。

## 3. 后果

### 正面

- “完成”从自述变成可核验事实；TC-009 的自述成功 + 构建失败会被拦下。
- TC-008 的越界修改由 `diffScope` 判失败，不会因为“代码能跑”而成功。
- M6 Brain 可以基于证据做决策，不再建立在不可信的执行结果上。
- 审批把“沙箱拦截”变成可操作流程，而不是黑盒失败。

### 负面（已接受）

- 每次执行多一轮验证开销；M5 的命令超时默认 10 分钟，后续可按检查类型调整。
- `llmReview` 目前只会得到 `manual_required`，不会给出自动结论；这是刻意保守。
- `approval approve` 只记录裁决，不自动放宽下一次执行；策略实体（PRD §11.16）尚未实现。

## 4. 被否方案

| 方案 | 否决原因 |
|---|---|
| 直接采信 Agent 的“测试通过” | 被验收方自证，产品核心价值塌掉 |
| 只跑一条 `diffScope` 就判 pass | 不能证明目标完成，会制造假通过 |
| 用 LLM 评审替代确定性检查 | 不可复现，且 M5 不解决评审质量问题 |
| sandbox 拦截当普通失败 | 用户无法区分“代码错”与“边界太紧”，也无法审批放宽 |

## 5. 复审触发条件

1. M6 Brain 需要把验收结果作为决策输入（确认事件/查询面稳定）；
2. M7 交付策略需要 `VerificationRun.verdict` + `diffScope` 作为前置条件；
3. 真实 harness 的验收命令需要不同的超时/网络策略；
4. 策略实体上线，Approval 可以自动应用到下一次执行。
