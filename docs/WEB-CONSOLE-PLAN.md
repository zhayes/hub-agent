# HubAgent Console Web 实施计划

- 状态：计划（尚未实施）
- 日期：2026-11-24
- 范围：M11 Web Console 收口 + Chat 入口
- 预览：`preview/web-chat.html`、`preview/web-console.html`
- 参考：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/PLAN.md`、`AGENTS.md`

---

## 1. 目标与边界

### 目标

把当前只读 Web 面板升级为可日常使用的本地控制台：

1. **Chat 作为第一入口**：用户直接描述任务，HubAgent 规划、执行、验收；
2. **明/暗/跟随系统** 三态主题，默认跟随系统；
3. 全站 **中文 + 英文** 国际化，日期/数字/相对时间走 `Intl`；
4. Chat 左 Threads、右 Context 两栏可折叠，桌面与移动端都可操作；
5. 去掉列表/导航的“边框选中”视觉，改用背景层级 + 字重 + 图标状态；
6. 所有交互遵循 WCAG 2.2 AA、键盘可达、IME 安全、触控目标 ≥44px；
7. 使用 Solid 2 纪律与既有 `modern-web-guidance` 平台能力，不引入第二套设计系统。

### 非目标（本计划不做）

- 直接和单个 Coding Agent 的一对一 Chat（先做 Orchestrator Chat）；
- token 级流式 LLM 输出（先做任务/事件级 SSE）；
- 移动原生 App、多人协作、远程公网部署；
- 完整 RTL 翻译（只做逻辑属性与 `dir` 预留）；
- 新任务图/成本图表（后续独立里程碑）。

---

## 2. 设计方向

### Signal Console

- 深色为默认观感，但**默认跟随系统**，不是硬编码 dark。
- 中性近黑 ground，不用 navy/slate；橙色只做信号，不做大面积品牌色。
- 卡片靠 1px 分隔和背景层级，不靠投影/发光。
- 核心记忆点：**Run Spine**（subtask → execution → verification → decision）。
- 列表不使用独立边框卡片；选中态用 `background + title weight + status icon`，禁止 `outline/box-shadow` 作为选中装饰。键盘 `:focus-visible` 仍保留 2px accent outline。

### Token 基线

```css
:root {
  color-scheme: light dark;

  --ground: light-dark(#f6f5f2, #0f1114);
  --surface: light-dark(#ffffff, #171a1f);
  --raised: light-dark(#eeede8, #1f242c);
  --line: light-dark(#d8d6cf, #303640);
  --text: light-dark(#17191c, #f5f7fa);
  --muted: light-dark(#5c6470, #b3bcc8);
  --faint: light-dark(#727a87, #8f99a6);
  --accent: light-dark(#c2410c, #ff8a5c);
  --positive: light-dark(#166534, #6ee7b7);
  --negative: light-dark(#b91c1c, #fda4af);
  --warning: light-dark(#92400e, #fcd34d);
  --surface-selected: light-dark(#f0eee8, #1d222a);
  --focus-ring: 2px solid var(--accent);
}
```

验收：正文 ≥4.5:1，icon/控件边界 ≥3:1；状态不能只靠颜色，必须同时有图标/文字。

### 主题切换

- 三态：`system`（默认）/ `light` / `dark`，不是简单二态。
- `meta[name=color-scheme]` 初始 `light dark`；内联脚本在 `<head>` 中读取 `localStorage` 防 FOUC。
- CSS 用 `:root:has(> head > meta[name="color-scheme"][content="dark"])` 映射 `color-scheme`，不要用 JS class 作为唯一来源。
- 订阅系统 `matchMedia` change 和跨 tab `storage`；用户显式选择后不因系统变化自动清空。
- 控件位置：rail 底部 Settings / 主题菜单；popover 内三项 `System (currently light/dark)`、`Light`、`Dark`。
- `prefers-reduced-motion` 下关闭宽度/抽屉过渡；`forced-colors` 下用系统色和 outline。

---

## 3. 信息架构

```text
Chat（默认）
  Threads
  Conversation
  Active task context（可折叠）
Tasks
  Queue
  Task detail
Agents
Approvals
Settings
```

- Rail 宽度 56px；Chat / Tasks / Agents / Approvals / Settings。
- Approvals 图标显示待处理数；数量为 0 时不显示。
- 移动端 rail 变底部导航，保留 safe-area padding。
- `Chat` 的第一屏先回答“当前 thread 在做什么、需不需要我”；不先放 KPI。

---

## 4. Chat 交互

### 线程

- 一个 Thread 关联一个 Goal；消息里的 taskId 可跳转 Task detail。
- 发送后立即插入用户消息和 Planning 占位，不阻塞输入。
- 运行中显示 Stop；Stop 走 cancel API。
- 完成后 result 卡提供 task 链接、diffstat、verification 摘要。
- 刷新后从服务端恢复；不依赖内存。

### Composer

- `Run` / `Ask` 两档：Run 创建任务，Ask 只读快照回答。
- 使用 `<form>` + `<button type="submit">`，不用裸 click 代替表单。
- Enter 提交必须 IME 安全：
  - `event.isComposing`；
  - Safari 兜底 `event.keyCode === 229`；
  - `event.preventDefault()` 后 `form.requestSubmit()`。
- `Shift+Enter` 换行；`Cmd/Ctrl+Enter` 提交。
- 所有 textarea 有显式 `<label>`（可 visually hidden）。
- 高级选项（agent/project/checks）折叠，不占主界面。
- Composer **不使用装饰性边框**：用 surface 背景与 ground 分层；`focus-within` 只做背景层级变化，键盘焦点仍保留可见 outline。
- 主操作尽量 icon-only：Send、Run/Ask、New、Open task、Copy、Collapse 都使用图标按钮，配 `aria-label` + `title`/tooltip；文字只保留在必要处。
- 图标按钮触控目标 ≥44×44，鼠标 ≥24×24。

### 结构消息

`plan / run / approval / clarification / result / answer` 六种。审批与澄清直接在消息内完成；不做“跳到另一个页面再回来”。

### 折叠

- 左 Threads：256px ↔ 56px（只剩状态点和新建按钮）。
- 右 Context：336px ↔ 48px（只剩图标入口）。
- 桌面用按钮 `aria-expanded`/`aria-controls`；Threads 和 Context 各自在 header 有折叠按钮，Conversation header 保留左右两个总开关；快捷键 `Alt+[` / `Alt+]`；状态存 localStorage。
- 折叠后的 Context 保留可点击的竖向 rail，Threads 折叠后保留状态点 + tooltip，不能只剩一个没有入口的空条。
- ≤1180px 默认收起 Context；≤820px 左右栏变 `<dialog>` 抽屉，打开时 `inert` 主内容、`aria-modal`、Escape 关闭、焦点回到触发按钮。
- 折叠不是 `display:none` 丢内容：收起时用 icon/计数入口保留可发现性。

---

### 动效与微交互（参考 Beautiful UI）

参考 [Beautiful UI](https://www.beautifului.dev/) 的 AI-native 组件语言，但只取模式，不复制视觉：

| Beautiful UI 模式 | HubAgent 映射 | 动效 |
|---|---|---|
| Loading State 像素网格 + 已耗时 | Run card 的“Planning / Executing”态 | 9 格像素呼吸，`opacity`/`transform`，显示 elapsed |
| Thinking 可展开 trace | Plan / Decision trace | `<details>` 式展开；默认只显示摘要，不展开全部 reasoning |
| Streaming Text | Ask 回答、未来 token 流 | 文本追加 + 1px 光标；不重建消息节点 |
| Approval Card | 审批 / 澄清 | 行内选项；选择后卡片就地收敛，不弹大 modal |
| Tool Chips | `pnpm test` / `diffScope` / `git` 等检查 | 紧凑 chip；点击展开 command/log |
| Task Rows | Thread / task 行 | 状态点 + 1px 进度；运行中只更新该行 |
| Context Cards | Evidence / retrieved logs | 折叠摘要；展开才拉完整内容 |
| Diff Table | changed files / diff | 懒加载、固定表头、长行截断 |
| Prompt Bar | Composer | `@agent` / `/command` 后续再做，先保留 Run/Ask |

动效纪律：

- 动效只做**反馈**：press、hover、focus、展开/收起、消息追加；不做页面入场、不做无限 glow。
- 只动 `transform` / `opacity`；禁止 `transition: all`，避免长列表每帧 layout。
- 折叠面板可做 120–180ms 宽度/网格过渡，但长列表打开虚拟化后改为瞬时或 `transform`，避免整页 reflow。
- 像素 loader 用 CSS grid + `animation-delay`；`prefers-reduced-motion` 下只保留静态状态点。
- 展开/收起用原生 `<details>` 或 `aria-expanded` + CSS grid rows；焦点不丢失。
- SSE 追加不触发整页动画；只让新消息/状态点有一次 120ms 的淡入（可关）。

### 长任务渲染性能

长任务页面不是“消息多”一个问题，而是 **DOM 节点 + 高频 SSE + 日志/证据全量渲染** 三件事叠加。分三层处理：

#### 1. 数据层

- Chat messages 用 cursor 分页：`thread_id, created_at, id` 索引；默认 50 条/页，向上加载历史。
- SSE 事件按 `messageId/executionId` 合并；同一帧内同一实体的多次更新只保留最后一次。
- 事件 UI 缓存上限 500 条；完整历史在 SQLite，不全部塞进 signal/store。
- Evidence/logs 按需拉取：列表只返回摘要；点击 chip 才请求完整日志。
- Task 详情分页：subtasks / executions / verifications 各自 cursor；不要一次 `SELECT *` 全量。

#### 2. 渲染层

- 对话 >100 条或 >50KB 文本时启用窗口化：
  - 优先 `@tanstack/solid-virtual`（先做 Solid 2 兼容 spike）；
  - 不兼容则用自研 `VirtualList`（固定行高 + 动态测量 + overscan 6–8 行）；
  - 未虚拟化前用 `content-visibility: auto` + `contain-intrinsic-size` 降低离屏成本。
- 消息/任务行用稳定 id 的 `<For>`；禁止 index key 和每次全量 `map` 重建。
- 长文本/日志分块：可见 200 行 + “Load more”；不把 10MB stdout 塞进 DOM。
- Context/evidence 面板 `contain: layout paint`；折叠时不渲染 body。
- 高频流式文本用可变 buffer + `requestAnimationFrame` 合并，最多 30fps 更新一个文本节点；不要每个 token `setStore` 整个数组。
- 派生值（状态、diffstat、耗时）用 `createMemo`；格式化只在值变化时做。
- 禁止在渲染函数里 `JSON.parse`、排序大数组、重复 `Intl` 构造。

#### 3. 网络/主线程

- SSE 单连接、`Last-Event-ID` 断点续传、指数退避；页面隐藏时暂停或降频。
- 事件到达后 `queueMicrotask`/`rAF` 批量应用；避免每事件一次同步渲染。
- 大日志/大 diff 的解析放到 Web Worker（后续；首版先分页 + 懒加载）。
- 开发环境用 `PerformanceObserver` 记录 long task（>50ms）并在 debug 面板显示。

#### 性能预算（本地桌面）

| 指标 | 目标 |
|---|---|
| 首屏可交互 | <1s（本地 daemon） |
| 1,000 条消息滚动 | 无明显掉帧，目标 60fps |
| 流式更新 | 主线程 long task <50ms |
| INP | <200ms |
| JS heap（1,000 条消息 + 摘要） | <100MB |
| 折叠/展开 | <1 次布局抖动，无整页白屏 |

**验收方式**：在 `?perf=1` 注入 1,000 条 mock messages + 500 events，Playwright 录 Performance trace；至少检查 long task、heap、滚动帧率。

## 5. 国际化

- 首批 `zh-CN` / `en-US`；默认 `navigator.languages`，无匹配回退 `en-US`，用户可覆盖。
- 文案全部进 `shared/i18n/locales/*` typed dictionary；组件里禁止硬编码 UI 文案。
- `t(key, params)` 只做完整句式，不拼接半句；错误用 error code 映射。
- 日期/相对时间/时长/数字/复数用 `Intl.DateTimeFormat`、`Intl.RelativeTimeFormat`、`Intl.NumberFormat`、`Intl.PluralRules`。
- 更新时间显示 `title` 绝对时间 + 可见相对时间；时区来自用户环境。
- `<html lang>` 跟随 locale；切换语言不刷新页面。
- CSS 使用 `margin-inline`、`padding-inline`、`inset-inline`；`dir` 先 `ltr`，为 RTL 预留。
- 增加 dictionary 完整性测试和“无硬编码文案”lint 规则。

---

## 6. 图标

- 使用 `lucide-solid`（UI 白名单允许）；不引入第二套图标库。
- icon-only 按钮必须有 `aria-label` 或 visually hidden 文本；装饰图标 `aria-hidden="true"`。
- 状态 = 图标 + 文本 + 颜色，不能只靠颜色。
- 主题：Sun / Moon / Monitor；折叠：PanelLeftClose / PanelRightClose；审批：BadgeCheck。
- 触控目标 ≥44×44；鼠标 ≥24×24；图标视觉 16–18px，命中区用 padding/pseudo 扩展。
- 图标与文字基线对齐；不把 lucide 图标塞进彩色圆角方块。

---

## 7. Solid 2 架构

```text
packages/web/src/
  app/
    App.tsx
    shell/AppShell.tsx
    shell/Rail.tsx
  routes/
    ChatRoute.tsx
    TasksRoute.tsx
    TaskRoute.tsx
    AgentsRoute.tsx
    ApprovalsRoute.tsx
    SettingsRoute.tsx
  features/
    chat/ThreadsPane.tsx
    chat/Conversation.tsx
    chat/Composer.tsx
    chat/ContextPane.tsx
    chat/message-cards/*
    tasks/*
    agents/*
    approvals/*
  components/ui/
    Button.tsx
    IconButton.tsx
    Panel.tsx
    StatusBadge.tsx
    CollapsiblePane.tsx
    ThemeMenu.tsx
    LanguageMenu.tsx
  shared/
    api/client.ts
    api/chat.ts
    sse/event-source.ts
    i18n/*
    theme/*
    format/*
    router/*
  styles/
    tokens.css
    base.css
    shell.css
    chat.css
    components.css
```

纪律：

- 不解构 `props`；用 `splitProps`/`mergeProps`。
- 列表用 `<For>`/`<Index>`，不 `map`。
- 不直接改 store；用 `setStore` 路径或 `produce`。
- 数据获取不放 `createEffect`；用显式 action/资源。
- 不引入 React 或第二套设计系统；组件基元在 `components/ui`，features 不直接依赖 UI SDK。
- 使用 `@solidjs/router@2.0.1`（peer 匹配 Solid 2）：`/chat/:threadId`、`/tasks/:id`、`/agents`、`/approvals`、`/settings`；页面切换用真实路由，不用 `<Show>`。见 ADR 0017。
- 不新增 `@ui-sdk/solid` 直到有 ADR；首版用自有 `components/ui` + lucide-solid，避免 beta API 绑死。

---

## 8. 后端依赖（Chat 真实可用前必须完成）

### 数据

- 新迁移 `006-chat.ts`：`chat_threads`、`chat_messages`。
- `chat_messages` 存 `thread_id`、`role`、`kind`、`content_json`、`goal_id`、`task_id`、`created_at`。
- 先只存结构化消息，不存 LLM 原始 token。

### Runtime

- `RunCoordinator`：异步启动 run，立即返回 `threadId/taskId`；事件写 events 表。
- `runGoalWithBrain` 增加 `onStarted`/预创建 Goal 能力，避免 HTTP 阻塞。
- Approval approve 后恢复 waiting_approval Execution/Subtask/Task。
- Clarification answer 后恢复 waiting_input。
- 所有恢复写 DecisionRecord，变更走状态机不绕过。

### API

```text
POST /api/v1/chat/threads
GET  /api/v1/chat/threads
GET  /api/v1/chat/threads/:id
POST /api/v1/chat/threads/:id/messages   { text, mode: run|ask }

POST /api/v1/tasks/:id/cancel
POST /api/v1/tasks/:id/pause
POST /api/v1/tasks/:id/resume
POST /api/v1/clarifications/:id/answer
```

- 全部走统一 Bearer 中间件；SSE 可用 `?token=`，但写接口不允许 query token。
- SSE 事件带 `threadId`/`goalId`/`taskId`；支持 `Last-Event-ID`。
- 写接口 CSRF/来源检查：仅同源 `Origin`，或 localhost。

---

## 9. 分阶段实施

### P0 — UX/Token 冻结（0.5 天）

- 确认 Signal Console 方向与三栏/折叠/主题/i18n 交互。
- 落 ADR：主题三态、i18n 方案、无边框选中、Chat 入口。
- 产出 token 表与组件清单。

**验收**：设计稿/preview 与本文无冲突；ADR 评审通过。

### P1 — 前端地基（1–2 天）

- `styles/tokens.css` + `base.css`；明暗 token、`light-dark()`、forced-colors。
- 主题三态 + FOUC 防护 + 系统同步 + `storage` 同步。
- i18n 字典、locale 切换、Intl 格式化、dictionary 完整性测试。
- `lucide-solid`、`components/ui` 基元、rail/shell。
- 折叠 pane 与移动抽屉；无边框选中态。
- 用 mock API 接入 Chat/Tasks/Agents/Approvals 骨架。
- 产出 v2 静态 preview：明暗主题、中英文、左右折叠、无边框选中。

**验收**：

- 首屏无 FOUC；system/light/dark 均可切换并持久化；
- 文本/图标对比度通过；
- 无硬编码 UI 文案（zh/en 均可用）；
- 桌面折叠状态持久化；移动抽屉可 Escape 关闭且焦点回退；
- `pnpm typecheck` + `pnpm lint` + web build 通过。

### P2 — Chat 后端（2–3 天）

- `006-chat.ts`、chat repository、RunCoordinator、onStarted；
- threads/messages API；
- SSE thread 过滤 + Last-Event-ID；
- approval/clarification resume；
- 单测覆盖：线程创建、消息追加、run 启动、审批恢复、澄清恢复、并发重复提交。

**验收**：HTTP 层可在 500ms 内返回 thread/task id；事件可重放；恢复不破坏状态机。

### P3 — Chat UI 接真实 API（2–3 天）

- Threads / Conversation / Context 三栏；
- plan/run/approval/result/answer 卡；
- Run/Ask、Stop、重试；
- SSE 重连、错误态、空态；
- 审批/澄清 inline 操作；
- 刷新恢复。
- 长列表分页 + 窗口化；流式更新 rAF 合并；日志/证据懒加载。

**已落地**：`/chat` 路由、异步 thread、Ask 快照、approval 卡、resume 新 attempt、Playwright 路由/折叠 E2E。

**验收**：

- 发 Run 后 1s 内出现用户消息与 Planning；
- task 创建后出现 taskId，context 可打开；
- approval approve 后 run 继续；
- SSE 断开后自动重连，不重复消息；
- 刷新页面 thread 完整恢复。

### P4 — Tasks/Agents/Approvals 重做（1–2 天）

- 用新 token/shell 重做旧三页；
- 移除旧边框卡片/选中效果；
- 表格用语义 table + 响应式堆叠；
- Agents 状态、Approvals 队列；
- 全量 i18n。

**验收**：320px 不横向溢出；表格可键盘滚动；审批操作和 Chat 一致。

### P5 — 质量门禁与收口（1 天）

- Playwright E2E：主题、i18n、折叠、IME、Chat happy path、审批恢复、SSE 重连；
- axe 扫描 + 对比度脚本；
- `?perf=1` 1,000 条消息 trace：首屏、long task、heap、滚动；
- 截图 1440/1024/390/320，明暗双主题；
- 文档：PLAN/ARCHITECTURE/ADR；
- `pnpm verify` + `pnpm test:e2e`；commit/push。

---

## 10. 测试与验收矩阵

| 维度 | 用例 |
|---|---|
| 主题 | system 默认、light/dark 覆盖、刷新持久、跨 tab 同步、无 FOUC |
| 对比度 | 正文 4.5:1、icon/控件 3:1、forced-colors |
| i18n | zh/en 切换、缺 key 回退、日期/相对时间/数字/复数 |
| 折叠 | 桌面持久、键盘、焦点管理、移动 dialog/inert/Escape |
| Chat | Run、Ask、Stop、审批、澄清、刷新恢复、SSE 断线 |
| IME | 中文/日文 composition 中 Enter 不发送 |
| 触控 | 44×44 目标、320px 无横向溢出、safe-area |
| 键盘 | Tab/Shift+Tab、Esc、`Alt+[`/`Alt+]`、`Cmd+Enter` |
| 视觉 | 无边框选中、状态不只靠颜色、无渐变/glow |
| 动效 | 像素 loader、trace 展开、消息追加、reduced-motion |
| 性能 | 1,000 条消息滚动、SSE 合并、日志懒加载、long task |
| 回归 | `pnpm verify`、`pnpm test:e2e`、`pnpm arch` |

---

## 11. 风险

1. **Solid 2 生态兼容性**：主题/i18n/router 依赖需 PIN 并先做 spike；不通过就不引包。
2. **Chat 后端阻塞**：`runGoalWithBrain` 同步、审批不恢复；这是 P2 的主要工程量，不能只做 UI。
3. **i18n 文案遗漏**：加 lint/字典完整性测试，不靠人工。
4. **主题闪烁**：必须用 inline script + meta 映射，不能只靠 JS class。
5. **折叠造成布局抖动**：统一 grid 变量，`prefers-reduced-motion` 关闭过渡。
6. **旧 Web 代码迁移**：P4 前保留旧页面可用，避免中间状态不可用。
7. **长任务性能**：虚拟化在 Solid 2 的兼容性、动态行高测量、SSE 高频更新需要专门 spike；不通过则降级为分页 + `content-visibility`。
8. **动效过度**：Beautiful UI 的模式只取反馈层，不做入场动画；所有动效必须能 `prefers-reduced-motion` 关闭。

---

## 12. 下一步

先做 **P0 + P1**：

- 冻结 token、主题、i18n、折叠、图标、无边框选中规则；
- 产出新的静态 preview（双主题 + 折叠 + 中英文切换）；
- 不改后端、不接真实 API，先确认视觉和交互。

确认后再进入 P2 Chat 后端，避免 UI 反复。
