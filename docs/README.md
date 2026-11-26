# HubAgent 文档索引

这份索引回答一个问题：**要改某个东西，应该看/改哪份文档。**
同一件事只在一份文档里写全，其他位置只放结论和链接——避免同一条规则散落在 PRD、PLAN、ADR、UI-SPEC 里各说一套。

## 入口

- 在仓库里动手之前先读 [AGENTS.md](../AGENTS.md)：分层规则、硬性约束、常用命令。
- 产品口径有冲突时，**PRD 优先**；实现方式以 ARCHITECTURE 为准；进度以 PLAN 为准。

## 文档地图

| 文档 | 回答什么问题 | 什么时候必须更新 |
|---|---|---|
| [README.md](../README.md) | 给使用者：安装、`ha web`、扫描/接入、限制 | 用法或限制变化时 |
| [AGENTS.md](../AGENTS.md) | 在这个仓库里怎么干活：依赖规则、Solid 纪律、常用命令 | 命令/目录结构/硬性约束变化时 |
| [PRD.md](PRD.md) | 产品边界、版本范围、验收标准、状态机与不变量 | 产品行为或验收口径变化时 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、进程模型、数据与接口的落地方式 | 跨层接口/进程模型变化时 |
| [PLAN.md](PLAN.md) | 里程碑顺序、门禁、每个 M 的实现进度 | 每个里程碑完成或范围调整时 |
| [PLAN-AGENT-ONBOARDING.md](PLAN-AGENT-ONBOARDING.md) | **Agent 接入**：内置目录、扫描、接入、`authenticate`、`ha web` | 接入规则/目录条目/状态机变化时 |
| [PLAN-AGENT-OFFICE.md](PLAN-AGENT-OFFICE.md) | 3D Agent 舞台（presence、场景、动效） | 舞台数据或交互变化时 |
| [PLAN-CHAT-UX.md](PLAN-CHAT-UX.md) | **对话页体验**：状态保持、消息层级、执行过程、授权卡片 | 对话页交互/数据源变化时 |
| [WEB-CONSOLE-PLAN.md](WEB-CONSOLE-PLAN.md) | 控制台前端的分阶段实施 | 控制台范围变化时 |
| [UI-SPEC.md](UI-SPEC.md) | 视觉令牌、布局、组件与可访问性规范 | 设计系统或页面规范变化时 |
| [REAL-HARNESS-BENCH.md](REAL-HARNESS-BENCH.md) | 真实 harness 的实测记录与命令 | 新增/复核真实 harness 时 |
| [BRAIN-PI.md](BRAIN-PI.md) | Brain 与 Pi SDK 的接入方式 | Brain 契约或 Pi 升级时 |
| [adr/](adr/) | 每个重要决定的背景、备选与被否方案 | 做新决定或推翻旧决定时 |
| [THIRD-PARTY.md](../THIRD-PARTY.md) | 第三方依赖与许可 | 依赖变化时 |

## 文档约定

1. **一个事实只写一处。** 需要重复时写结论 + 链接，不复制细节。
2. **改了行为就同 PR 改文档。** 包括 PLAN 里的“实现进度”，不要留到下一轮。
3. **不写死会漂移的数字。** 用例数、模块数以 `pnpm verify` 的实际输出为准，文档里只写“全绿”。
4. **文档与代码冲突先报告。** 按 AGENTS.md：先确认哪一边才是意图，再动手改。
5. **新增专项计划**命名 `docs/PLAN-<TOPIC>.md`，并登记到本索引；完成后在 PLAN.md 留一行指向它。

## 当前已知的文档债

见 [PLAN-AGENT-ONBOARDING.md §5](PLAN-AGENT-ONBOARDING.md) 的对齐清单（C1–C15），随实现进度逐条销账。
