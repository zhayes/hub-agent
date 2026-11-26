# ADR 0022：Chat 是对话，不是任务表单

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-26
- **相关：** PRD §9.2、ARCHITECTURE §M11、WEB-CONSOLE-PLAN §4、ADR 0018、ADR 0012
- **证据：** `chat-service.ts`、`brain-run.ts`、`reply` 动作、`chat.test.ts`、`brain-run.test.ts`、真实 Pi 模型 smoke

---

## 1. 背景

首版 Chat 只有两种模式：`Run` 把每条消息变成 Goal → Task → ACP 执行；`Ask` 只读任务证据快照，完全不调模型。带来的实际表现是：

- 用户说“你好”也会走一遍拆计划，Brain 返回 `request_human`（“你想做什么？”）时，`runGoalWithBrain` 的初始回合只认 `revise_plan`，直接抛 `Brain 未产出 revise_plan`；模型其实答了，控制台只显示错误。
- 用户在 “Ask” 下发一句话只会得到 “No task is linked to this thread yet.”，因为 Ask 不调模型。
- 用户配置好的 Pi 模型只能做决策，不能对话；控制台看起来像“聊天”，实际是任务表单。

## 2. 决策

1. **一条输入、一条链路**：Chat 只有一档输入，消息永远是“一次 Brain 回合”，由 Brain 决定直接回答还是动手；删掉 Run/Ask 切换和 Ask 快照通道。
2. **新增 `reply` 动作**：Brain 可以直接回文本；`finish` 在还没有计划时同样按回答处理。只回复的回合不建 Task，Goal 以 `completed` 收敛，`stopReason = replied`。
3. **计划不再是第一回合的硬要求**：初始回合允许 `request_human`（落 Clarification，thread 进 `waiting`）和 `reply`/`finish`；只有 `revise_plan` 才建 Task。
4. **快照带对话窗口**：`BrainInput.conversation` 携带最近若干轮用户/助手文本（最多 40 条消息、24 轮、约 6000 字符；task/approval 卡片和旧错误不进上下文）。CLI 不传，行为不变。
5. **澄清选项进 UI**：`GET /api/v1/clarifications/:id` 返回 options/status，澄清卡按选项渲染按钮；自由文本只用于无 options 的问题（`answerClarification` 仍只接受精确命中的选项）。
6. **模型直接回自然语言不算失败**：`PiBrain.parseActions` 解析不出 JSON 时按 `reply` 处理，而不是抛 `BRAIN_UNAVAILABLE`。

## 3. 被否方案

- **保留 Ask 只读快照**：用户问“你能做什么”时只能得到“没有任务”，与“对话入口”的定位冲突；证据查询已经在任务详情和审批卡片里。
- **每条消息必须建 Task**：把闲聊/提问变成失败任务，且 Goal/Task 表被对话噪声污染。
- **在 Chat 里另起一套 OpenAI-compatible 客户端**：违反 ADR 0012（模型配置/认证/session 统一由 Pi 负责），会引入第二套凭据与预算路径。
- **把澄清问题塞进 `chat_messages.content` 让 UI 解析选项**：解析字符串脆弱；选项属于 Clarification 本身。

## 4. 后果

- 对话路径不产生 Task，`RunGoalWithBrainResult.taskId` 变成可选；CLI/JSON 输出要能表达“只回复”（已处理，文本打到 stdout）。
- 对话历史来自 `chat_messages` 而不是 Pi session；Pi session 仍然每回合重建、无状态，符合“快照可重放”。
- Approval/Clarification 的“继续”仍按 ADR 0018 走新 attempt；精确续跑同一 execution 依旧未实现。
- 对话窗口有上限；超长对话只把最近窗口给模型，完整历史仍在 SQLite，UI 可回看。

## 5. 复审触发条件

- 需要 token 级流式输出（当前是整段回复落库后经 SSE 推送）；
- 需要精确续跑同一 execution，而不是新 attempt；
- 需要把 Chat 暴露给远程用户（届时对话窗口、预算与鉴权都要重新评估）。
