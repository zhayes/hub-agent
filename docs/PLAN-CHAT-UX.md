# PLAN-CHAT-UX：对话页的状态保持、消息层级与过程可见

> 状态：P0–P3 已实施（2026-11-26）；P4 待做
> 关联：PRD §9.2、ARCHITECTURE §M11、WEB-CONSOLE-PLAN §4、ADR 0018、ADR 0022

## 1. 现场问题（来自 15:09 的真实会话）

1. 用户问「你能让我本地的 dsh 写个笑话段子吗」→ 建 Task → `session/new 失败：Authentication required`。
   - 同一台机器 14:13 的探测还是 `online`，15:09 建会话却要登录；失败**没有留下 execution / event**，只有一条 chat 错误消息，所以事后无法从任务页复盘。
2. 点「打开任务」跳到 `/tasks/:id`，再回 Chat：`/chat` 没有 id → 空态；即使再点回原 thread，也要重新拉取、页面先空一下。
3. 用户消息和助手消息视觉上几乎一样（都只有一行 `你/HubAgent · 时间` + 正文），扫一眼分不清谁说的。
4. 整个过程只有一条「加载中」，看不到 Brain 在做什么、派给了谁、卡在哪一步。

## 2. 目标（可验收）

- **T1 状态保持**：从任务页返回，仍停在原 thread，消息与滚动位置立即可见，不闪空态。
- **T2 一眼可辨**：用户消息右对齐气泡，助手消息左对齐 + 头像/名称，颜色不是唯一区分信号。
- **T3 过程可见**：每次执行有「理解 → 计划 → 派给谁 → 执行/重试 → 验收 → 结果」的可展开时间线；失败时自动展开并给出可操作项。
- **T4 失败可操作**：Agent 需要授权时，聊天页内直接给「授权 / 重试」，不用去终端或 Registry 页。

## 3. 方案

### P0 状态与导航（0.5–1 天）

- 新增 `packages/web/src/features/chat/store.ts`（模块级，不引入新依赖）：
  - 缓存 `threads`、当前 `thread`、`messages`、`lastSeq`、`scrollTop`；
  - ChatView 挂载时**先渲染缓存**，再后台刷新并合并（沿用现有 `merge by id`）；
  - 卸载不清理，只标记 stale。
- 记住最后打开的 thread：`localStorage['hubagent.chat.lastThread']`；路由 `/chat`（无 id）时自动 `navigate('/chat/<last>', { replace: true })`，没有记录才显示空态。
- 「打开任务」改为新标签（`target="_blank" rel="noreferrer"`），聊天页不卸载；header 里的任务入口同样处理。若之后要做「右侧任务抽屉」，在本阶段预留 `onOpenTask` 的第二个参数。
- 断线重连：`streamSeq` 持久化到 store，SSE 重连用 `after` 续传，不再整页替换消息。
- 验收：`/tasks/:id` 返回后 thread、消息、滚动位置都在；Playwright 覆盖「打开任务 → 返回 → 同一 thread」。

### P1 消息视觉层级（1 天）

只改 `MessageRow` 的呈现，不动数据结构：

| 角色 | 布局 | 视觉 |
|---|---|---|
| 用户 | 右对齐，最大 74ch | `bg-accent-soft` 气泡，左下角时间；无头像 |
| 助手 | 左对齐 | `H` 圆形头像 + `HubAgent` 名称，正文 markdown 无气泡 |
| 错误 | 整宽 | `bg-danger-soft` 卡片 + 图标，附操作 |
| 审批/澄清 | 整宽 | 保持现有卡片，标题用角色色 |

- 连续同一角色的消息合并头部（只在角色切换时显示名称/时间）。
- 时间默认 `ink-3`，hover 才显示完整时间；移动端不显示秒。
- 验收：明暗两套截图；320px 无横向溢出；只看轮廓也能区分（对齐 + 头像 + 气泡三重信号）。

### P2 执行过程（1.5–2 天）

数据结构：`ChatMessage.kind` 增加 `'progress'`（kind 是 TEXT 列，**无需迁移**）。

- Runtime：`RunGoalWithBrainOptions` 增加 `onProgress?: (step) => void`，在这些点上报：
  - `received` 收到消息 / 开始理解；
  - `planned` 计划就绪（子任务数与标题）；
  - `selected` 选择 Agent；
  - `dispatching` 开始执行（session/new）；
  - `retrying` 重试（第 N 次，原因）；
  - `verifying` 验收开始；
  - `completed` / `failed`（含失败归类）。
- ChatService：`onProgress` 落库为 `role='assistant', kind='progress'`，SSE 自动推送；刷新后仍在。
  - `turnsOf()` 只取 `text` / `clarification`，progress 天然不进 Brain 上下文。
- 前端：连续 `progress` 合并成一张 `ThinkingTrace`：
  - 运行中：显示最后一行 + 计时；
  - 完成：折叠为「过程 · N 步 · 12s」；
  - 失败：自动展开并高亮失败步骤。
- 纯问答回合不落 progress，只在输入框上方显示「正在思考…」计时（现有 LoadingState）。
- 验收：dsh 那次失败在新 UI 里显示为「计划 1 步 → 派给 dsh → session/new 失败（需要授权）」，不用打开任务页。

### P3 授权与错误可操作（1 天）

- Runtime：ACP `session/new` 报 `Authentication required` 时：
  - `setAgentStatus(agent.name, 'needs_auth')`（当前 dsh 仍显示 `online`）；
  - 失败结果带 `failure: 'auth'` 与 agent 名。
- Chat：追加 `kind='auth'` 卡片（assistant）：
  - 先 `verifyAgent(name)` 拿 `authMethods`；
  - 按方法渲染按钮 → `loginAgent(name, methodId)`；
  - 成功后自动重跑上一条用户消息（复用 `resume`）。
- 没有 `authMethods` 时给出文案：在终端执行该 Agent 的登录命令（dsh 需用 DSH 自己的登录），并提供「重新探测」。
- 其他 ACP 错误卡片统一带「重试 / 打开任务 / 查看日志」。
- 验收：聊天页内完成授权并重跑；Registry 页状态同步为 `needs_auth → online`。

### P4 打磨（可选）

- 消息级「复制 / 重试 / 引用」；
- token 级流式输出（现在整段落库后推送）；
- Stop / 取消；
- 按 thread 记住草稿。

## 4. 接口与类型变更

| 位置 | 变更 |
|---|---|
| `domain/chat.ts` | `ChatMessageKind` 增加 `'progress' \| 'auth'` |
| `runtime/brain-run.ts` | `onProgress` 回调（可选，CLI 不传） |
| `runtime/chat/chat-service.ts` | 落库 progress / auth；`turnsOf` 仍只取 text/clarification |
| `web/features/chat/store.ts` | 新增，线程/消息/滚动缓存 |
| `POST /api/v1/agents/:name/authenticate` | 已存在，直接复用 |
| `chat_messages` | 迁移 010 增加 `agent_name`；`kind` 是 TEXT，新增 `progress` / `auth` 不需要改列 |
| `web/features/chat/store.ts` | 缓存 thread/messages/游标/滚动/草稿；`/chat` 无 id 时回到上次对话 |

## 5. 风险与约束

- progress 只记关键点（≤8 条/回合），不逐 token，避免消息表膨胀。
- 旧 thread 没有 progress：UI 必须能接受空。
- 授权后重试是「重跑上一条消息」（ADR 0018 新 attempt）；dsh 在 session/new 就失败，没有副作用，安全。若未来失败发生在执行中，需要先做精确续跑再自动重试。
- 所有新组件仍走 `components/ui/*` 门面，不在 `features/**` 直接 import `@ui-sdk/*`。

## 6. 落地记录（2026-11-26）

- P0：`features/chat/store.ts` + ChatRoute 的 last-thread 重定向；缓存命中时消息与侧栏在 API 挂起时仍能渲染（已用 Playwright 挂起 `/api/v1/chat/threads/**` 验证）。
- P1：`MessageRow` 用户右对齐气泡、助手头像/名称；连续同角色 5 分钟内只显示一次头部。
- P2：`RunGoalWithBrainOptions.onProgress` → `kind='progress'` 消息；UI 合并成「执行过程」，失败/等待/紧跟授权卡时自动展开。
- P3：ACP 授权失败落 `kind='auth'` 卡片并 `setAgentStatus(needs_auth)`；卡片内 verify → authenticate → 重跑上一条消息。
- 测试：`brain-run.test.ts` 覆盖进度顺序；`chat.test.ts` 覆盖 progress/auth 不进模型上下文。
- 验证：`pnpm typecheck` / biome / `pnpm arch` 通过；Playwright 在挂起 `/api/v1/chat/threads/**` 时仍能从缓存渲染消息与侧栏，`/chat` 与侧栏入口都回到上次 thread。

## 6.1 验收后的修正（2026-11-26）

- **空对话不再“加载中”**：`chat_threads` 新增 `idle` 状态，新建 thread 落 `idle`；`active` 还要求至少有一条消息（兼容旧数据）。新建后显示「空闲 + 开场提示」，不再出现计时器。
- **左侧列表去掉状态点**：状态已由标题栏和右侧面板表达，列表回归“标题 + 最后一条 + 时间”。
- **右侧上下文默认收起**：面板只放本对话的状态、消息数、目标与关联任务；执行细节跳到任务页。内容顶部有一句说明，避免再被误解为“证据面板”。

## 7. 顺序与门禁

1. P0（状态保持）→ 立刻解决「回来是空页」。
2. P1（消息层级）→ 纯前端，可并行设计评审。
3. P2（过程）→ 需要 Runtime 回调，补单测：progress 顺序、失败链路、不进上下文。
4. P3（授权）→ 依赖 P2 的错误卡片；补 dsh/workbuddy 的 needs_auth 状态同步测试。

每阶段：`pnpm typecheck` + 相关单测 + 明暗双主题截图；P0/P1 可先合入体验。

## 8. 眼下 dsh 的授权（不属于本计划代码）

dsh 当前需要重新登录：Agents / Registry 页 → dsh → 探测 → 选认证方式；或用 dsh 自己的登录流程。本计划 P3 会把这条路径搬进聊天页，避免再去别处找。
