# ADR 0018：Chat 使用异步 thread + task，不阻塞 HTTP 请求

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** WEB-CONSOLE-PLAN §4/§8；ADR 0017
- **证据：** `chat.test.ts`、daemon `/api/v1/chat/*` smoke、`ChatView` 真实 API smoke

---

## 1. 背景

Web Chat 需要“发一条消息 → 创建 Goal/Task → 跑几分钟 → 显示结果”。如果 `POST` 直接 await `runGoalWithBrain`，请求会阻塞数分钟，页面无法刷新/取消，SSE 也没机会推送。

## 2. 决策

1. `chat_threads` + `chat_messages` 持久化 thread、消息和 goal/task 关联。
2. `POST /api/v1/chat/threads/:id/messages` 只追加用户消息并启动后台 run，返回 202；不等待任务完成。
3. `RunCoordinator`（首版由 `ChatService` 在 daemon 进程内实现）在后台调用 `runGoalWithBrain`，通过 `onGoalCreated/onTaskCreated` 尽早回填 thread 的 goal/task。
4. 结果写回 `chat_messages`（task/approval/result/error）；Web 通过轮询 thread + 全局 SSE 更新。
5. Ask 模式只读快照，不创建 run。
6. Approval/Clarification 的“继续”当前实现为**新 attempt**：approve/answer 后调用 resume 接口，用最后一条用户消息重新启动 run；不重置原 waiting execution。原 task 保留为 waiting。
7. 不做直接 Agent 一对一 Chat；Chat 是 Orchestrator 入口。

## 3. 被否方案

- **同步 await run**：HTTP 超时/无法刷新/无法取消。
- **只做前端假消息**：无法证据化，违背产品原则。
- **批准后直接改 waiting Task 为 running**：会绕过 runtime 的 execution/worktree 语义；首版先新 attempt，后续再做精确 resume。

## 4. 后果

- Chat 首次响应快；长任务在后台跑。
- 刷新页面可从 SQLite 恢复 thread/messages。
- Approval resume 是“继续对话”的近似语义，不是同一 execution 的精确续跑；README/UI 必须标明。
- 需要后续补：Thread SSE 过滤、clarify answer、精确 approval resume、分页/窗口化。

## 5. 复审触发条件

- 需要精确恢复同一 execution；
- 多用户/远程 Chat；
- 消息量超过分页预算。
