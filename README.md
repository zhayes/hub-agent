# HubAgent

本地优先的多 Agent 编排系统：把本机已经装好的 Coding Agent（DSH、Hermes、WorkBuddy、Qwen Code、Claude Code、Codex…）通过 ACP 接到一起，由一个 Brain 决定派谁干活，并用 Runtime 拿证据验收。

> 当前是本地开发版：命令行为 `ha`，开发入口 `pnpm ha …`。npm 发布与全局安装推迟，约束见 [PLAN-AGENT-ONBOARDING.md 附录 A](docs/PLAN-AGENT-ONBOARDING.md)。

## 环境要求

- Node.js **>= 22.19**（`pnpm doctor` 会检查）
- pnpm 10
- macOS 需要 `srt` 与 `rg`；Linux 另需 `bwrap`、`socat`
- 至少一个支持 ACP 的本地 Agent（见下文「扫描与接入」）

沙箱是 **fail-closed**：依赖缺失或沙箱不可用时，HubAgent 拒绝执行任务，不会降级为无隔离。

## 快速开始

```bash
pnpm install
pnpm build:web        # 构建控制台静态资源（首次或改前端后）
pnpm ha web           # 起 daemon + 托管控制台，打印访问地址
```

输出类似：

```text
✓ HubAgent 已启动
  控制台   http://127.0.0.1:7788
  运行目录 ~/.hubagent
  Ctrl-C 停止
```

浏览器打开该地址即可。token 由页面注入，不需要手动复制。

端口被占用时会自动顺延到下一个，并把实际地址打印出来。

## 扫描与接入

控制台左侧 **接入（Connect）** 页面：

1. 进入页面自动扫描本机（只读文件检测，不启动任何进程）；
2. 每行是一个内置目录里的 Agent，点「接入」写入注册表并做一次 ACP 验证；
3. 验证结果分三种：**在线** / **需要登录**（按它声明的登录方式登录）/ **连接失败**（可查看 stderr）。

零可用 Agent 时页面会明确说「本机没有检测到可接入的 Agent」，不会伪造占位项。

内置目录只覆盖 [catalog/builtin.json](packages/hub/catalog/builtin.json) 里的条目，随版本发布，不做远程下发。目录之外的 harness 用 CLI：

```bash
pnpm ha agent add --name internal --cmd "/opt/company/harness --acp"
pnpm ha agent list
```

命令行等价操作：

```bash
pnpm ha agent scan                              # 扫描本机
pnpm ha agent adopt hermes                      # 接入并验证
pnpm ha agent verify hermes                     # 重新验证
pnpm ha agent login workbuddy --method oauth    # 完成登录
```

接入规则与边界见 [ADR 0021](docs/adr/0021-builtin-agent-catalog.md)：目录只决定「怎么启动」，不参与协议解析，也不做版本判断。

## 跑一个任务

**任务只能在控制台里发**（ADR 0029）：打开 `pnpm ha web` 的地址，在对话里说你要干什么，Brain 决定直接回答还是拆计划交付本机 Agent 执行。CLI 不提供任务创建。

```bash
pnpm ha web
# 浏览器打开打印出的地址，在对话里描述目标
```

判定由 Runtime 执行，不采信 Agent 自述；运行结束后在控制台看 `branch / commitSha / diffstat / changedFiles` 与验收结果。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm ha web` | 启动 daemon + 控制台，打印地址 |
| `pnpm ha doctor` | 检查 Node / 目录 / 数据库 / 沙箱 / git |
| `pnpm ha agent scan \| adopt \| verify \| login \| add \| list \| show` | Agent 接入与注册表 |
| `pnpm ha run <goal>` | **诊断入口**：默认拒绝，需 `--allow-task-create`（ADR 0029） |
| `pnpm ha task …` / `pnpm ha approval …` | 任务查看与恢复、审批（不创建任务） |
| `pnpm ha config \| logs \| gc \| maintenance` | 运行目录、日志、清理、投影重建 |

所有命令都支持 `--json`。

## 目录结构

```text
packages/hub/          daemon 与 CLI（单个 npm 包，内部分层）
  src/domain/          纯模型与不变量
  src/brain/           决策层（Pi）
  src/runtime/         状态机、调度、恢复、Agent 接入
  src/adapters/        ACP 客户端
  src/agent-host/      子进程监管
  src/sandbox/         srt 沙箱
  src/storage/         SQLite、迁移、投影
  src/interfaces/      HTTP / SSE / CLI
  catalog/             内置 Agent 目录
packages/web/          Solid 2 控制台（Chat / Tasks / Agents / Connect / Approvals / Settings）
docs/                  PRD、架构、计划、ADR、UI 规范
```

## 安全边界

- 本地服务只监听 `127.0.0.1`，所有 `/api` 走统一 Bearer token（由页面注入）。
- 所有子进程经 `SandboxProvider` 启动，Coding Agent 与验证命令同一等级隔离；沙箱不可用即拒绝执行。
- 接入只做用户显式触发的验证，不自动安装、不自动下载、不自动探测。
- 任务执行期不弹窗、不抢占桌面焦点：桌面型 Agent 通过 `ELECTRON_RUN_AS_NODE` 之类无窗口入口启动。

## 已知限制

- 只有内置目录里的 Agent 能在页面上接入；目录随版本更新。
- Codex / Claude Code 需要额外的 ACP 适配器，未安装时在接入页显示「不可接入」。
- Pi（`@earendil-works/pi-coding-agent`）是 Brain 的 SDK，不是 ACP Agent，不在目录里。
- 验收默认转人工复核时，任务会停在 `waiting_input`，需要显式处理。
- 控制台需要 WebGL2 才能显示 `/agents` 3D 舞台；接入页不受影响。

## 开发

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome + eslint(solid)
pnpm test:unit     # vitest
pnpm test:e2e      # playwright
pnpm arch          # dependency-cruiser
pnpm verify        # 以上全部 + build:web
```

文档索引见 [docs/README.md](docs/README.md)；产品口径以 [docs/PRD.md](docs/PRD.md) 为准。
