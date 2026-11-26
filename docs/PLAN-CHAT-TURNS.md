# 对话回合视图与资源阅读器

状态：P0/P1/P2/P4/P5-A/P5-B 已落地（2026-11-26）。

## 1. 为什么改

旧对话页把 assistant 的每条消息都渲染成独立卡片（过程、任务、授权、回答各一个身份），看起来像三个角色在对话；右侧栏只是摘要，不能阅读任务进度或文件；审批后只能把最后一条用户消息重跑一遍。

现在一个用户消息 = 一个回合：

```
[用户] 让 dsh 写个笑话
🤖 已完成 · 用时 12分49秒 ⌄   ← 一个折叠头
   ├ 思考：……
   ├ 计划：……
   ├ 派给 dsh：……
   ├ 工具：写入 src/a.ts · completed
   └ 验收 pass
   写好了……（最终回答）
   [任务 · 已完成] [a.ts] [b.ts]   ← 产物
```

## 2. 实现要点

### 回合化（前端派生，不迁移）

- `ChatView` 按 user 消息切回合；回合内 `steps`（progress/task/approval/clarification/auth/error）+ `final`（最后一条 text/result）。
- 有 steps 的回合只出现一个 `H` 身份；`ThinkingTrace` 头显示 `执行中/已完成/失败 · 用时`、步数与最后一条过程摘要。
- 运行中、失败、等待授权，或回合内含卡片时自动展开；完成态默认折叠。
- 任务/文件改为回合产物 chip；点任务打开右侧任务进度，点文件打开只读预览。
- 旧历史不需要迁移，打开时即时推导。

### 右侧资源阅读器

- 面板状态 `overview | task | file`，带「返回」；点产物自动展开。
- 任务视图复用 `GET /api/v1/tasks/:id`：子任务、执行（attempt/状态/改动文件）、验收项。
- 文件视图：`GET /api/v1/tasks/:id/file?path=`，只允许该任务 `evidence.changedFiles` 内的路径；根目录取最新 execution 的 lease worktree（不存在则 project root）；拒绝绝对路径/`..`、realpath 必须落在根内、≤512KB、NUL 判二进制。
- **只读**：没有写入/保存端点。

### Agent 路由与授权

- Brain `delegate.agentId` 现在真正生效（此前固定用 `listAgents()[0]`）；没点名时保持默认 Agent，换 Agent 留给重试时的 Selection Engine。
- 授权卡挂载不再自动探测；「重新检测」才 `verifyAgent`，前端同 Agent 单飞，锁冲突显示「正在检测…」；可直接选其他 Agent 重跑。

### 流式

- Brain 聊天回合走自然语言输出：`PiSession.subscribe` 的 `text_delta` 经 `OrchestratorBrain.step(input, sink)` 流到 ChatService，80ms 节流更新同一条消息（SSE `message.update`）。
- 模型仍吐 JSON 时前端不显示 JSON；只当前言则回合结束降级为 thinking。
- ACP `message.delta`（thought/agent）同样 80ms 合并；工具状态即时更新。

### 精确续跑

- 审批（sandbox-denied 验收）后：`execution_resume`（迁移 013）保存 worktree + checks；`resumeExecution` 原地重跑验收，**同一 execution**，不重跑 Agent。工作区回收则 409。
- 澄清（waiting_input）后：沿用同一 Goal/Task，只对等待中的子任务开新 attempt，不重新分解计划。

## 2.1 运行反馈与排障（2026-11-26 补）

- 每次发送立刻落一条 `thinking` 步骤「正在分析你的请求…」，Brain 的 thinking 增量会把它替换成实际思考；不再出现十几秒只有“加载中”。
- 工具调用从 `rawInput` 补标签（`执行 …` / `读取 …` / `编辑 …`），`tool_call_update` 保留原标题再追加状态。
- 工具行可展开：`chat_messages.detail`（迁移 014）存 `{command,path,output,kind}`，前端 `<details>` 展示命令与返回结果。
- 思考/输出默认压缩成两行（`line-clamp`），点「展开」看全文；回合头默认只显示一行摘要，失败/等待/含卡片才自动展开。
- 任务成功时用 Agent 的最终输出作为回答（追加为回合最后一条 text），不再只显示「任务完成：编号」；流式输出行收成一句提示。
- `runAcpTask` 的沙箱写授权合并 `agent.allowedWrite`（dsh 的 `~/.dsh`、workbuddy 的 `~/.codebuddy`），否则 Agent 自己写 profile 时会直接退出。
- dsh 自带内层沙箱，嵌套会 `sandbox_apply` 失败；注册命令加 `DSH_PERMISSION_MODE=danger-full-access`（迁移 015 + catalog），外层隔离仍由 HubAgent 提供（ADR 0025）。
- Agent 失败时把 stderr 尾部写进错误卡；若含 `sandbox_apply`，附加提示「HubAgent 本身在沙箱里，请从系统终端重启」。
- `pnpm ha web` 启动时自检 `sandbox-exec`；嵌套沙箱会打印警告。
- 任务阅读器有 error/retry 状态：`/tasks/:id` 失败或未返回时不再永远显示“读取中”。

## 3. 边界

- 沙箱放宽只覆盖写路径；网络类拒绝仍需单独策略。
- 旧审批没有 `execution_resume` 现场，只能降级为新 attempt。
- 文件预览依赖 worktree 尚未回收；回收后显示提示并引导打开任务页。
- ACP Agent 自身的逐字输出取决于它是否发 `message.delta`。

## 4. 关键位置

- `packages/web/src/features/chat/ChatView.tsx`：`turns` / `TurnBlock` / `TaskViewerPanel` / `FileViewerPanel`
- `packages/hub/src/runtime/chat/chat-service.ts`：`createBrainStream`、`createEventSink`、`finishExactResume`、`continueWaitingTask`
- `packages/hub/src/runtime/resume-execution.ts`
- `packages/hub/src/runtime/task-files.ts`
- `packages/hub/src/storage/migrations/013-execution-resume.ts`
