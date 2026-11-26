# Agent 接入（Onboarding）与 `ha web` 实施计划

**状态：** 已实施（S0–S6）· 2026-11-26
**目标：** 一条命令（`ha`）起 HubAgent，打开控制台，扫描本机可接入的 Agent，逐个接入后交给调度。**本期只做本地开发**：命令名定为 `ha`，开发入口 `pnpm ha …`；npm 发布与打包推迟（约束记录在附录 A，避免以后返工）。
**前置阅读：** `docs/PRD.md` §6.3、`docs/ARCHITECTURE.md`、`docs/PLAN.md` M4/M9、`docs/adr/0020-3d-agent-stage.md`
**冲突时的口径：** PRD 的版本边界与安全底线优先；本计划对 PRD 的修正已记在 §5 文档对齐清单。

---

## 0. 一句话结论

把“手工注册 Agent”换成一个**内置目录 + 扫描 + 接入**的闭环：

```text
pnpm ha web
        →  打印 http://127.0.0.1:<port>
        →  /registry 自动扫描本机  →  每行「接入」
        →  ACP initialize 验证  →  在线 / 需要登录 / 连接失败  →  出现在 /agents 舞台
```

内置目录随版本发布，不做远程下发；页面不做手动填命令；无窗口启动是硬约束。

---

## 1. 已确认的决策

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| D1 | 页面是否保留“手动接入” | **不做**。CLI 的 `agent add` 保留 | 页面只有扫描/接入/重新验证 |
| D2 | 缺 ACP 适配器的行 | **显示但不可操作**，写清原因 | Codex / Claude Code 行常驻但无法点 |
| D3 | 目录更新方式 | 随版本发布，**不做远程下发** | 目录是包内数据文件 + 版本号 |
| D4 | DSH 桌面版 / CLI | **同一条目、两个变体**；表格只显示来源文字，无切换器（方案 A），默认桌面版 | 目录条目 `dsh` 含 `variants` |
| D5 | WorkBuddy | 收录，状态可能是“需要登录” | 新增 `needs_auth` 状态 |
| D6 | `authenticate` | **进本期** | AcpClient 增加登录能力 |
| D7 | 扫描是否执行二进制 | **不执行**，只做文件检测（WorkBuddy 的 `--version` 会下载 62 MB） | 目录里没有 versionCheck 字段；检测只有 which/path/bundle 三种 |
| D8 | 何时扫描 | 进入 `/registry` 自动扫描一次（每 daemon 会话），另有刷新按钮 | 首屏就有结果 |
| D9 | 桌面应用会不会弹窗 | 不会——只用 `ELECTRON_RUN_AS_NODE` 等无窗口入口 | 目录条目必须声明 headless |
| D10 | 登录发生在什么时候 | **只在接入阶段**，任务执行期禁止弹窗 | 状态机区分“需要登录”与“连接失败” |
| D11 | 命令名 | **`ha`**（Hub Agent 缩写）是唯一对外的命令名；本地开发入口 `pnpm ha …` | `bin/ha.ts`、`program.name('ha')`；npm 打包推迟（附录 A） |
| D12 | npm 发布 | **本期不做**，只保证“以后能发”不被结构堵死 | 资源一律按包根解析、不依赖 cwd/`tsx`；打包细节见附录 A |
| D13 | 并行执行上限 | 默认 **5**（可配置） | 舞台/设置里展示当前并发；超过时排队，不静默丢弃 |

### 待拍板（不阻塞 S0/S1）

| # | 问题 | 建议 |
|---|---|---|
| P1 | `doctor` 是否加 agents 检查 | 加，**非阻塞**，只报告“已接入 N / 在线 M” |

---

## 2. 现状与实测证据（2026-11-26）

| 项 | 结果 |
|---|---|
| `pnpm test:unit` | 389 用例 / 54 文件全绿 |
| `pnpm hubagent doctor`（现名，可写 home） | node 26.12.1、srt 0.0.83、rg 15.2、git 2.50.1 全绿 |
| mock ACP 端到端 | 成功：worktree → prompt → diff → commit → evidence → transcript |
| `hubagentd`（现名）空库启动 | 正常，`/api/v1/agents` 返回空列表 |
| `hubagentd`（现名）跑过一次任务后 | **崩溃**：`EVENT_REJECTED: 不允许 waiting_input → unknown`（100% 复现） |
| `agent add` | 不校验命令，状态永远 `discovered`，直到跑任务才变 `online` |
| 控制台托管 | `GET /` 返回 SPA，`__HUBAGENT_TOKEN__` 已注入，`/agents` 200，assets 200 |
| WorkBuddy 5.3.5 | 内置 CLI `codebuddy 2.115.0`；`initialize` 成功（4 种登录方式）；`session/new` 返回 `-32000 Authentication required` |
| WorkBuddy 副作用 | 跑一次 `--version` 就下载两个插件市场，**62 MB / 5399 文件**，写入 `~/.codebuddy` |
| Pi 1.6.0 | **不是 ACP Agent**（无 ACP SDK、无 `acp` 入口），不收录 |
| 本机候选 | DSH 桌面版 ✅、Hermes ✅、WorkBuddy ✅（需登录）、Qwen Code ❌、Claude Code ❌、Codex ⚠️ |

---

## 3. 设计

### 3.1 术语（定死，避免歧义）

| 词 | 含义 | 起进程 | 写库 |
|---|---|---|---|
| **扫描 scan** | 按内置目录检测本机装了哪些可接入的 Agent | 否（只 `stat` 文件） | 否 |
| **验证 verify** | 起进程走 ACP `initialize`（+ `session/new`） | 是 | 否 |
| **接入 adopt** | 写 `agents` 表 + 验证 | 是 | 是 |
| **重新验证 re-verify** | 对已接入的再验证一次 | 是 | 只更新状态 |
| **监测 presence** | `/agents` 舞台看运行态 | 否 | 否 |

### 3.2 内置目录 schema

目录是**包内数据文件**，不是散落在代码里的 `if (name === 'dsh')`：

```
packages/hub/catalog/builtin.json     ← 随版本发布
```

单条记录：

```jsonc
{
  "id": "workbuddy",                 // 稳定 id，接入后写入 agents.catalog_id
  "label": "WorkBuddy",              // 展示名
  "name": "workbuddy",               // 接入后的默认 Agent 名
  "os": ["darwin", "win32"],
  "detect": {
    "kind": "bundle",                // bundle | which | path
    "paths": [
      "/Applications/WorkBuddy AI.app",
      "/Applications/WorkBuddy.app",
      "~/Applications/WorkBuddy AI.app",
      "~/Applications/WorkBuddy.app"
    ],
    "entry": "Contents/MacOS/Electron",
    "cli": "Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
    // asar 内的路径不落盘：加 "virtualCli": true 跳过存在性检查
  },
  "requires": [],                    // 缺失时显示原因、禁止接入（如 ACP 适配器）
  "headless": true,                  // 硬约束：必须是无需窗口的入口
  "command": "ELECTRON_RUN_AS_NODE=1 \"<entry>\" \"<cli>\" --acp",
  "allowedWrite": ["~/.codebuddy"],  // 接入后写入 agents.allowed_write
  "notes": "与桌面应用使用不同配置目录，首次接入需要登录"
}
```

字段规则：

- `headless` 必须为 `true` 才能收录；包含 `open` / `start` / `.app` 默认入口的命令一律拒绝。
- 扫描**不执行任何候选二进制**，因此目录里没有 `versionCheck` 字段。
- `command` 里的 `<entry>` / `<cli>` 由检测结果替换，避免硬编码绝对路径。
- `requires` 用于表达“装了但接不上”，例如 `{"kind":"which","name":"codex-acp"}`。

### 3.3 内置条目（6 条，7 个启动变体）

| id | 显示名 | 变体 | 检测 | 命令 | 本机 |
|---|---|---|---|---|---|
| `dsh` | DSH | desktop / cli | App bundle / `which dsh` | `… bin.js --profile acp` / `dsh --profile acp` | ✅ 桌面版 |
| `hermes` | Hermes | — | `which hermes-acp` | `hermes-acp` | ✅ |
| `workbuddy` | WorkBuddy | — | App bundle + 内置 CLI | `ELECTRON_RUN_AS_NODE=1 … --acp` | ✅（需登录） |
| `qwen-code` | Qwen Code | — | `which qwen` | `qwen --acp` | ❌ |
| `claude-code` | Claude Code | — | `which claude-code-acp` | `claude-code-acp` | ❌ |
| `codex` | Codex | — | `which codex-acp` + codex 二进制 | `codex-acp` | ⚠️ 缺适配器 |

规则补充：

- **变体合并为一行**（D4）。多个变体都检测到时按 `desktop > cli` 选，行内只显示来源文字，不提供切换控件。
- 适配器类条目（Claude Code / Codex）检测的是**适配器可执行文件**，不是产品本身。
- 未安装的条目**不显示行**，只在页脚一行小字列出内置支持范围（不含安装引导）。
- 收录纪律：条目必须在本机实测过 `initialize`，记录里带 `verifiedAt`。

### 3.4 扫描规则

1. 遍历目录 → 逐条 `stat`（bundle 检查目录/文件存在；which 检查 PATH）。
2. **不执行任何候选二进制**（D7）。
3. 检测结果与 `agents` 表合并：已接入的行标记 `registered`，且保留在列表中（即使本机已卸载）。
4. 结果缓存在 daemon 进程内，带时间戳；页面显示“上次扫描 N 分钟前”。
5. 扫描失败（目录文件损坏）只影响该条目，不中断整体。

### 3.5 接入流程与状态机

```text
candidate(未接入)
   │ 点「接入」
   ▼
adopting（前端瞬态，禁止重复点击）
   ├─ initialize + session/new 成功  ──▶ online（记录 capabilities / lastSeenAt）
   ├─ -32000 Authentication required ──▶ needs_auth（展示登录方式）
   │        └ 用户选择登录方式 → authenticate → 重试 session/new
   ├─ ADAPTER_INCOMPATIBLE / 超时    ──▶ error（记录 stderr 尾部 + 退出码）
   └─ 本机已无此文件                  ──▶ missing（已接入但检测不到）
```

要点：

- **接入失败也保留记录**（命令本身有效，失败通常是登录/网络/依赖问题），可重试或移除。
- `needs_auth` 与 `error` 必须分开：前者可操作，后者要排障。
- 首次接入 WorkBuddy 会下载插件市场（实测 62 MB），接入超时给 **90 秒**，并在行内提示“首次接入会下载插件市场”。
- 验证/接入使用**临时空目录**作为 cwd，不碰用户仓库。
- 任务执行期**不允许**弹出任何窗口或登录流程（D10）。

### 3.6 页面 `/registry`

```
接入                              内置目录 v1 · 上次扫描 1 分钟前   [重新扫描]
┌────────────────────────────────────────────────────────────────────────────┐
│ Agent        来源 / 命令                    状态            操作              │
├────────────────────────────────────────────────────────────────────────────┤
│ ● DSH        桌面版 · 0.2.2-rc.3           已接入 · 在线    [重新验证] [⋯]   │
│ ● Hermes     ~/.local/bin/hermes-acp       未接入           [接入]            │
│ ● WorkBuddy  5.3.5 · 需要登录              需要登录          [登录] [⋯]       │
│ ● Codex      ChatGPT.app 内置 · 缺少 ACP 适配器   不可接入    —（原因可展开）  │
└────────────────────────────────────────────────────────────────────────────┘
内置支持：DSH · Hermes · WorkBuddy · Qwen Code · Claude Code · Codex
```

- 进入页面自动扫描一次（D8），另有刷新。
- 表格在 < 860px 堆叠为卡片，320px 不横向溢出；命令列 `break-all`。
- 行操作：`接入` / `重新验证` / `登录` / `⋯`（查看原因、编辑、停用、移除）。
- 空态：**“没有检测到可接入的 Agent”** + 一行说明扫描范围，不放假按钮。
- 键盘与 aria：状态用文字 + 徽章，不只靠颜色；操作按钮有 `aria-label`；扫描结果 `aria-live="polite"`。
- `/agents` 舞台只改一处：空态链接到 `/registry`（不引入 2D 列表，ADR 0020 不破）。

### 3.7 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/agents/scan` | 扫描目录，返回候选 + `registered` 标记（不执行二进制） |
| POST | `/api/v1/agents/adopt` | `{catalogId, variantId?}` → 注册 + 验证 |
| POST | `/api/v1/agents/:name/verify` | 重新验证 |
| POST | `/api/v1/agents/:name/authenticate` | `{methodId}` → 走 ACP `authenticate`（terminal 类型拒绝） |
| PATCH | `/api/v1/agents/:name` | `{status}` → `disabled` / `discovered`（停用/启用） |
| DELETE | `/api/v1/agents/:name` | 移除注册（历史 Execution 保留） |
| GET | `/api/v1/agents` | 已有，补 `catalogId` / `needsAuth` 字段 |

- 全部走现有 Bearer 鉴权中间件。
- 扫描/接入是长操作：接入同步返回（最长 90s），前端行内 spinner；批量接入不做。

### 3.8 数据模型

`agents` 表新增列（migration 009）：

| 列 | 用途 |
|---|---|
| `catalog_id` | 对应目录条目；App 更新后路径变了可重新解析 |
| `catalog_version` | 接入时的目录版本，便于提示“目录已更新” |
| `variant_id` | desktop / cli |
| `last_probe_at` | 上次验证时间 |
| `last_probe_error` | 失败原因（code + stderr 尾部） |

`status` 取值收敛为：`discovered` / `online` / `needs_auth` / `error` / `disabled`（`missing` 留给后续“已接入但本机消失”的检测）。
其余（busy / starting 等）继续由 presence 读模型派生，**不写库**。

### 3.9 `ha` 命令与 `ha web`

`ha` 是应用唯一对外命令（Hub Agent 缩写），所有子命令挂在它下面：

```text
ha web [--port 7788] [--open]   # 起 daemon + 托管控制台，打印访问地址
ha run <goal> …                 # 现有 run（脚本驱动 / 带 Brain）
ha agent add|list|show|probe    # 注册表命令
ha task … / ha approval …       # M9 已有面
ha doctor / ha config / ha logs / ha gc / ha maintenance
ha --version
```

本期只有本地开发入口：`pnpm ha web`（`tsx` 直跑源码，无需构建）。命令名已经按将来发布定死为 `ha`，未来加 `bin` 时不用改用户习惯。

实现要点：

- **单一入口**：`packages/hub/src/bin/ha.ts`，`program.name('ha')`；`hubagentd` 保留为内部/兼容别名。
- **抽 `startHub()`**：从 `bin/hubagentd.ts` 取出，返回 `{url, tokenPath, close}`；`ha web` 与测试共用。
- **资源按包根解析**（npm 安装后 cwd 不可信）：`webDist`、`catalog/builtin.json` 一律相对 `import.meta.url`。
- **端口占用自动 +1 重试**，打印 `http://127.0.0.1:<port>`（token 由 HTML 注入，不用手抄）。
- **`--open` 可选**：默认不自动开浏览器，避免 CI / 无头环境意外弹窗。
- dist 缺失时打印明确指引，不返回 404 白屏。

---

## 4. 与 PRD §18.9 的边界（必须写进 ADR 0021）

PRD §18.9 禁止“per-harness 特判、版本嗅探、版本绑定表”。内置目录**不违反**的前提是：

| 允许（启动知识） | 禁止（协议特判） |
|---|---|
| 知道某个 harness 如何以 ACP 模式启动（argv/flags/env） | 按 harness 名改协议解析 |
| 检测文件存在、读取 `--version` 并**展示** | 用版本号决定行为、维护兼容矩阵 |
| 提示“缺少 ACP 适配器” | 自动安装、自动下载、给安装命令 |
| 多平台路径差异 | 为某 harness 的输出格式写兜底 |

ADR 0021 需要明确：**目录只决定“怎么启动”，不参与“怎么理解协议”**。

---

## 5. 文档对齐清单

| # | 位置 | 现状 | 处理 |
|---|---|---|---|
| C1 | `AGENTS.md:100` | 写 `pnpm dev` 启动 daemon，但 `package.json` 没有该脚本 | 改为 `pnpm ha web` |
| C2 | `AGENTS.md:101` | 说 `dev:web` 代理 `/api`，`vite.config.ts` 实际没有 proxy | 给 vite 加 `/api` proxy（推荐），否则改文档 |
| C3 | `strings.ts:20,88` | 空态提示 `agent add --command`，实际参数是 `--cmd` | 改正 |
| C4 | `UI-SPEC.md:271`、`ADR 0020:27` | 提到 `hubagent agents`，实际命令是 `hubagent agent` | 改正 |
| C5 | `PLAN.md` 多处 | 写死“284 用例”，实际 370 | 改为“以 `pnpm verify` 输出为准” |
| C6 | `PRD.md:822` | “CLI 退出码固定为无可用 Agent”，但未定义具体码（现走 RUNTIME=5，`pnpm` 还会压成 1） | 定义 `CLI_EXIT.NO_AGENT = 6` 并补测试 |
| C7 | `PRD.md` §6.3.3 | 列了 9 个 Agent 状态，实际 `agents.status` 只写 discovered/online | 明确“存储态 vs presence 派生态” |
| C8 | `PRD.md` §6.3.5 | 要求“定期检查进程和连接状态”，与“不做自动探测（有副作用）”冲突 | 改为“执行期状态由 Runtime 维护；空闲 Agent 只在接入/手动时验证” |
| C9 | `ADR 0020` / `UI-SPEC §11` | “3D-only，操作路径是 CLI” | 补一句：接入页是独立 2D 配置页，不属于 `/agents` 约束 |
| C10 | `docs/adr/` | 缺内置目录的决策记录 | 新增 **ADR 0021：内置 Agent 目录与启动知识边界** |
| C11 | 仓库根 | **没有 README.md，也没有 LICENSE** | 补 README（快速开始/目录/进度/已知限制）；LICENSE 单独确认 |
| C12 | `PLAN.md` M4 | 真实 harness 只记录了 DSH / Codex | 补 WorkBuddy 实测（initialize 成功、session/new 需登录、62 MB 副作用） |
| C13 | `packages/hub/src/interfaces/cli/cli.ts` | `program.name('hubagent')`、帮助文案、错误前缀都是 `hubagent` | 统一为 `ha`（保留 `hubagent` 作为兼容别名） |
| C14 | 仓库根 `package.json` | 只有 `hubagent` / `hubagentd` 脚本，没有 `ha` | 增加 `"ha": "tsx packages/hub/src/bin/ha.ts"`；发布配置推迟（附录 A） |
| C15 | README | 缺失 | 新增 README：前置环境、`pnpm ha web`、扫描/接入、已知限制；发布方式只留一句“后续提供” |

**2026-11-26 已全部销账：** C1–C15（命令与参数、PRD 三处口径、3D 边界、ADR 0021、`ha` 入口与脚本、README、PLAN 的 WorkBuddy 实测）。

### 5.1 文档治理

本功能的**主文档就是本文件**，其余位置只放结论和链接，不复制细节：

| 文档 | 只放什么 |
|---|---|
| `PRD §6.3` | 产品口径：零可用 Agent 的结论、退出码、状态收敛 |
| `ADR 0021` | 边界：什么算启动知识、什么算协议特判 |
| `UI-SPEC §11` | 一句边界说明：3D 约束只作用于 `/agents` |
| `PLAN.md` | 一行指针 + 里程碑状态 |
| `docs/README.md` | 索引登记 |

新增/修改 Agent 支持时，只改本文件与 `catalog/builtin.json`，不要去 PRD 里加条目。

---

## 6. 切片、验收与估时

| 切片 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **S0** ✅ | 修 daemon 恢复扫描崩溃：`waiting_input` / `starting` / `created` 不再强转 `unknown`；恢复失败不终止启动 | `run` 一次后 `hubagentd` 能正常启动；新增 3 条单测 | 0.5d |
| **S1** ✅ | `ha` 单一入口（`bin/ha.ts`、`program.name('ha')`）+ 抽 `startHub()` + `ha web`：资源按包根解析、端口自增、打印地址 | `pnpm ha web` 打印地址；`curl /` 200 且含 token；从任意 cwd 启动都能找到 web 资源 | 0.5–1d |
| **S2** ✅ | 目录 schema + 6 条内置条目 + `POST /agents/scan` | 本机扫出 3 条；扫描不产生任何文件 | 1d |
| **S3** ✅ | 接入/验证/状态机 + migration 009 | DSH 接入成功；WorkBuddy 返回 `needs_auth` | 1d |
| **S4** ✅ | `authenticate` + 登录态处理 | WorkBuddy 登录后 `session/new` 成功 | 0.5–1d |
| **S5** ✅ | `/registry` 页面（表格/空态/抽屉/i18n/响应式）+ 导航 + 舞台空态链接 | 320px 不溢出；键盘可达；axe 无阻断 | 1.5–2d |
| **S6** ✅ | 收尾文档（C11/C12/C15）+ README + 真 daemon 集成 e2e | `pnpm verify` 全绿；e2e 覆盖扫描→接入→舞台 | 0.5–1d |

**合计：5.5–7.5 人日。**

### 测试矩阵

| 层 | 用例 |
|---|---|
| 单测 | 目录解析与非法条目；扫描去重/变体合并；状态映射（auth vs error）；migration 009；exit code |
| 集成 | 真 daemon：`scan` → `adopt`（mock ACP）→ `GET /agents` → 舞台可见；`pnpm ha web` 从 `/tmp` 启动也能托管控制台 |
| E2E | `/registry` 首屏、接入中的 spinner、失败原因展开、320px 布局 |
| 手动 | 关闭所有 Agent 应用后接入：Dock/任务栏无新图标（macOS 用 `lsappinfo list \| grep -c ASN` 前后对比） |

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 目录被判定为 PRD §18.9 的 per-harness 特判 | 返工/评审卡住 | 先落 ADR 0021，明确“只决定怎么启动” |
| WorkBuddy 版本漂移（本机 5.3.5，文档里 5.5+） | 路径变化导致检测失效 | `catalog_id` + “目录已更新，重新解析命令” |
| 首次接入 62 MB 下载 | 误判为卡死 | 行内提示 + 90s 超时 + 可重试 |
| 恢复扫描再次把 daemon 弄崩 | 所有后续功能不可用 | S0 先做，并补“恢复失败不终止启动” |
| E2E 依赖 3D canvas | 既有 flaky | 新用例只覆盖 `/registry`，舞台只断言空态链接 |
| 资源定位仍按 cwd | 从非仓库目录启动时 404 | S1 强制 `import.meta.url`，测试从 `/tmp` 启动 |

---

## 8. 明确不做

- 远程目录下发 / 定时拉取（`local-first`，且引入供应链风险）。
- 自动安装、自动下载 Agent 或适配器、给安装命令。
- 页面里的自由命令输入框。
- 扫描阶段执行任何候选二进制。
- 给 `/agents` 加 2D 列表或降级视图。
- 批量接入 / 批量验证（一期）。
- Pi 收录（1.6.0 不是 ACP Agent）。

---

## 9. 执行顺序

1. **S0**（先修崩溃，否则 `ha web` 一跑就炸）
2. ~~C10 ADR 0021~~（已完成）
3. **S1**（先把 `ha` 入口和 `ha web` 立起来，后面的切片都长在这个形状上）
4. **S2 → S3 → S4 → S5**
5. **S6**（C11/C12/C15 + README + e2e）与 S5 收尾合并

每个切片结束跑：`pnpm typecheck && pnpm lint && pnpm test:unit`；触碰 HTTP/页面再加 `pnpm test:e2e`。

本地冒烟清单（每个切片结束）：

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm ha web --port 7801        # 打印地址；页面能打开
pnpm build:web                 # 控制台构建产物存在
```

发布检查清单移到附录 A，等真正要发 npm 时再执行。

---

## 10. 实施结果（2026-11-26）

### 已交付

| 切片 | 落点 | 验证 |
|---|---|---|
| S0 | `runtime/recovery/scan.ts` 只收敛状态机允许的执行；`hubagentd` 恢复失败不终止启动 | 单测 2 条；手工 `run`（waiting_input）后 daemon 正常起 |
| S1 | `bin/ha.ts`、`interfaces/http/server.ts`（`startHub`）、`ha web`、端口自增、包根解析 | `hub-server.test.ts` 4 条；从 `/tmp` 启动可托管控制台 |
| S2 | `catalog/builtin.json`（6 条）、`runtime/agent-discovery/{catalog,detect,scan}.ts`、`POST /agents/scan`、`ha agent scan` | 本机扫出 DSH / Hermes / WorkBuddy / Codex（缺适配器）；单测 7 条 |
| S3 | `runtime/agent-probe.ts`、`runtime/agent-adopt.ts`、migration 009、adopt/verify/PATCH/DELETE 端点 | `agent-adopt.test.ts` 5 条；真实接入 Hermes 成功 |
| S4 | `AcpClient.authenticate`、`authenticateAgent`、`/agents/:name/authenticate`、`ha agent login` | 登录成功路径 + terminal 方式拒绝（单测） |
| S5 | `/registry` 页面（扫描/接入/验证/登录/停用/移除/详情）、导航项、舞台空态链接 | Playwright 2 条（含 320px 不溢出） |
| S6 | 本文档、README、ADR 0021、PLAN 的 WorkBuddy 实测、PRD 口径 | `pnpm verify` 全绿：389 用例 / 113 模块 / arch 无违规；Playwright 15 条全绿 |

### 与计划的差异（诚实记录）

- **去掉 `versionCheck` 字段**：扫描一律不执行二进制，字段没有存在意义。
- **`needs_auth` 的判定**：initialize 声明了 authMethods 且 session/new 失败，就归为「需要登录」；不依赖具体 JSON-RPC 码（Hermes 返回的是 `-32603 Internal error`）。
- **`~` 展开用真实用户 home**（`os.homedir()`），不是 Hub 运行目录——否则 allowedWrite 会指到 `.hubagent/.hermes`。
- **没有做**：编辑 profile、`missing` 状态检测、并发上限 5 的运行期展示（配置项尚未落到设置页）。
- e2e 用的是 mock API（与现有控制台测试一致）；真 daemon 的覆盖在 `hub-server.test.ts` 与手工冒烟里。

### 手工冒烟（本机）

```bash
pnpm ha web                       # 打印地址，页面可开
pnpm ha agent scan                # 4 条：DSH / Hermes / WorkBuddy / Codex(缺适配器)
pnpm ha agent adopt hermes --json # status=online，allowedWrite=/Users/<me>/.hermes
```

---

## 附录 A · npm 发布（本期不做，仅记录约束）

推迟发布，但结构上先不挖坑。将来要做时按这份清单落地：

| 项 | 约束 |
|---|---|
| 包名 | `hubagent`（实测 npm 未被占用；`ha` 已被占用 v0.0.17） |
| bin | `{ "ha": "dist/bin/ha.js" }`，带 shebang；`npx hubagent` 只做临时试用，不落 PATH |
| 产物 | `dist/`（编译后 JS）+ `catalog/` + `web/`；不能发 TS、不能依赖 `tsx` |
| 构建 | `pnpm build:hub` + `pnpm build:web`，`prepack` 串联 |
| `files` | 只发 `dist` / `catalog` / `web` / `README.md` |
| `engines` | `node >= 22.19.0`；`better-sqlite3` 需匹配 ABI |
| 定位 | 所有资源用 `import.meta.url`，不依赖 cwd |

本期为它做的准备：`ha` 命令名、`startHub()` 抽取、资源按包根解析。
