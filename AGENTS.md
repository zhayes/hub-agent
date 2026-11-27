# AGENTS.md

本仓库是 **HubAgent**：本地优先的多 Agent 编排系统。

动手之前请先读：

- `docs/PRD.md` —— 产品边界、版本范围、验收标准（产品约束的唯一口径）
- `docs/ARCHITECTURE.md` —— 技术落地方式（分层、进程模型、数据与接口）
- `docs/PLAN.md` —— 实施顺序与里程碑门禁（当前做到哪一步，看这里）
- `docs/README.md` —— 文档索引：什么东西该改哪份文档（先看这个）
- `docs/adr/` —— 决策记录：为什么这么定，以及当时否掉了什么
- `node_modules/@ui-sdk/solid/docs/llms.txt` —— 用 UI SDK 前先读；新建组件时再按标题搜 `core.md`，并读旁边的 `rendering.md`

冲突时：PRD 的版本边界与安全底线优先；实现细节以 ARCHITECTURE 为准。

写文档时遵守 `docs/README.md` 的约定：同一事实只写一处，行为变了同 PR 更新文档。

---

## 目录地图

后端是**单个 npm 包**，内部按层分目录；前端是独立的 Solid SPA。

```text
packages/hub/src/
  domain/          纯模型与不变量，零 IO
  brain/           决策层
    orchestrator-brain.ts   唯一对外契约
    pi/                     唯一允许 import Pi 的目录
  runtime/         状态机、调度、事件、验证、工作区、恢复、Agent 接入
  adapters/        ACP / A2A / Relay
  agent-host/      子进程监管（预留拆进程）
  storage/         schema、迁移、仓储、投影查询
  interfaces/
    http/          Hono 应用、SSE、鉴权、静态资源
    cli/           commander 命令
  shared/          错误码、时间、ULID、日志（叶子层）
  bin/             ha.ts（主入口）、hubagentd.ts、hubagent.ts（兼容）

packages/web/src/
  app/             壳层（AppLayout）、路由拓扑、全局 store
  routes/          页面骨架与路由参数
  features/        chat / tasks / inbox / agents / registry / approvals / settings
  components/ui/   设计系统门面（features 与 routes 不得直连 @ui-sdk / @lucide/solid）
  dev/             组件画廊（仅 DEV 进图）
  shared/          api 客户端、注意力派生（attention）、i18n、格式化
  styles/          令牌、Tailwind 入口、动效
```

返回目录

`packages/hub/catalog/` 是内置 Agent 目录；`fixtures/` 存放回归基线任务与 ACP 录制样本。

---

## 不可违反的规则

### 依赖方向（由 `dependency-cruiser` 强制，CI 失败即阻断）

| # | 规则 |
|---|---|
| R1 | `domain/**` 不得 import 任何其他层 |
| R2 | `brain/**` 不得 import `storage/**`、`adapters/**` |
| R3 | `runtime/**` 不得 import `brain/pi/**`，只依赖 `brain/orchestrator-brain.ts` |
| R4 | `adapters/**` 不得 import `runtime/**` |
| R5 | `interfaces/http` 只读可用 `storage/queries`，不得 import `storage/write` |
| R6 | `shared/**` 不得 import 任何业务层 |
| R7 | 禁止 barrel 文件（不要写 `index.ts` 转导出） |
| R8 | 只有 `agent-host/**` 与 `sandbox/**` 可 import `node:child_process` |
| R9 | `agent-host/**` 不得 import `storage/**`（拒绝启动不能写任务记录） |

### 其他硬性约束

- **事务内禁止 I/O**：不在事务里起进程、跑命令、调模型。
- **Brain 不写文件、不改任务状态**：只能产出结构化动作（intent），由 Runtime 校验后执行。
- **不按 Agent 生成工具**：只用稳定元工具（`discover_agents` / `get_agent_detail` / `delegate_task` / `await_any` / `get_task_result` / `cancel_task` / `revise_plan` / `request_human`）。
- **验收不得自证**：判定来自 Runtime 执行的检查与证据，不采信 Agent 自述。
- **本地服务只监听回环地址**，新增端点必须走统一鉴权中间件。唯一例外是 A2A Server：独立端口、默认关闭、需显式启用，且必须有自己的 Peer 鉴权，不复用本地 token（见 ADR 0026）。
- **所有子进程必须经 `SandboxProvider` 启动**：Coding Agent 与验证命令同一等级隔离；沙箱不可用时**拒绝执行**（fail-closed），不得降级为无隔离。
  - **唯一例外**：`agent-host/native-picker.ts`——daemon 主动弹出的**系统目录选择框**（macOS `osascript choose folder`）。它不是 Agent 执行、不读写用户项目内容，且套上 srt 后 GUI 根本弹不出来。它只实现于 `agent-host/`（允许 import `child_process` 的层），且**不接受任何路径参数**（只能返回用户在系统框里选的目录）。新增此类例外必须先说明理由再写代码。
- **不引入 React 及其生态包**；Solid 组件不得解构 props。
- **UI 层依赖白名单**：只允许 `tailwindcss` / `@ui-sdk/core` / `@ui-sdk/solid` / `@lucide/solid`（Solid 2 专用；`lucide-solid` 是 Solid 1 包，勿用），以及 `three`（仅限 `features/agents/office/scene/**`，精确锁版本、懒加载，见 ADR 0020）。新增 UI 依赖先写 ADR；不得引入整套组件库或第二套设计系统（见 ADR 0004、ADR 0019、`docs/UI-SPEC.md`）。
- **不得在 `features/**`、`routes/**` 直接 import `@ui-sdk/*` 或 `@lucide/solid`**：只能通过 `components/ui/*` 门面（SDK 处于 beta）。

---

## Solid 纪律（静默错误，务必遵守）

| # | 禁止 | 正确做法 |
|---|---|---|
| S1 | 解构 `props` | 只用 `props.x`；需要拆分用 `splitProps` / `mergeProps` |
| S2 | 用 `map` 渲染列表 | 用 `<For>` / `<Index>` |
| S3 | 直接改 store 对象 | 走 `setStore` 的路径写法或 `produce` |
| S4 | 把 `createEffect` 当 `useEffect` | 它是响应式副作用；数据获取用 query，不要放这里 |
| S5 | 在组件外读取 signal | 读取必须在追踪作用域内（effect / memo / JSX） |
| S6 | 自研小工具 | 优先 `@solid-primitives/*` |

---

## 常用命令

以 `package.json` 的 scripts 为准，常用为：

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome + eslint(solid)
pnpm test:unit     # vitest
pnpm test:e2e      # playwright
pnpm ha web        # 启动 daemon + 托管控制台，打印访问地址
pnpm dev:web       # 只起 vite；/api 代理到 7788，token 自动注入（需先 pnpm ha web）
```

---

## 改动流程

1. 先判断改动落在哪一层；跨层需求优先改接口，而不是直接跨层 import。
2. 涉及状态机或契约：同步更新 `docs/PRD.md` 对应章节与迁移表。
3. 改完必须跑 `pnpm typecheck` + 相关单测；触碰状态机需跑属性测试。
4. 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`）。

## 如果发现文档与代码不一致

报告不一致，不要默默跟随错误代码。改代码前先确认哪一边才是正确意图。
