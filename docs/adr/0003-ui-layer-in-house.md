# ADR 0003：UI 组件层自研（平台原语 + Tailwind v4），不绑定 UI 组件库

- **状态：** 已被 **ADR 0004** 部分取代（仅「组件基座」条款；平台原语、令牌、三道回归网仍有效）
- **日期：** 2026-11-23
- **相关：** ARCHITECTURE §2.2 / §8.6 / §8.7；AGENTS.md「UI 依赖白名单」
- **取代：** ARCHITECTURE V1.1 中「Kobalte + solid-ui」的组件基座选择

---

## 1. 背景

架构 V1.1 原计划：Solid 2.x + Kobalte + solid-ui（shadcn 风格移植）+ Tailwind v4。

实际风险在于**版本耦合**：

- Solid 2.0 是新 major，而 Kobalte、solid-ui、corvu 等 UI 层均以 1.x 为目标；
- solid-ui 又构建在 Kobalte 之上，风险叠加；
- 一旦某个基座库不适配 2.0，就要么回退框架版本、要么 fork 组件库——两种都在为一个"样式问题"付架构代价。

同时，浏览器平台能力已经把这个缺口填掉了很大一块：`<dialog>` 提供焦点陷阱与 `::backdrop`，Popover API 提供浮层与轻量关闭语义，`<details>` 提供展开语义。剩下的只有浮层定位需要一点计算。

结论：**把 UI 层从"依赖某个组件库"改成"依赖 Web 标准 + 一小层自己的组件"**。

---

## 2. 决策

1. **不使用整套 UI 组件库作为基座。** 不使用 Kobalte / solid-ui / Ant Design / MUI 级别的依赖。
2. **优先平台原生原语**：`<dialog>.showModal()`、Popover API、`<details>`、原生表单控件。
3. **UI 依赖白名单只有三个**：`tailwindcss`、`@floating-ui/dom`（定位）、`lucide-solid`（图标）。白名单外的新增必须先写 ADR。
4. **设计令牌单一来源**：Tailwind v4 `@theme` + CSS 变量；组件内禁止硬编码颜色/间距/字号。
5. **复杂组件按需引入 headless SDK**：仅 combobox / listbox / date picker 这类手写易错项允许引入 `@ark-ui/solid`（需先做 2.0 兼容 spike），其余一律自研。
6. **三道回归网**：`/dev/ui` gallery + Playwright 截图比对 + `@axe-core/playwright`；每个组件三件套（实现 / 测试 / gallery 条目）。

---

## 3. 后果

### 正面

- **与 Solid 主版本解耦**：2.0 → 2.1 乃至将来换框架，`components/ui` 的行为几乎不动。
- **视觉完全可控**：令牌化之后，"美化 UI"是调变量，不是和组件库的默认样式打架。
- **包体与心智更小**：没有第二套设计系统、没有样式覆盖战。
- **a11y 可度量**：axe + gallery 让"自己封装"变成可回归的工程，而不是手艺人行为。

### 负面（已接受）

- **交互细节要自己负责**：焦点管理、键盘导航、滚动锁定、屏幕阅读器语义。用原生原语能覆盖大半，但 combobox / date picker 仍需专门处理。
- **组件数量成本**：按 PRD 页面估算约 18 个（Button / Input / Select / Tabs / Dialog / Popover / Tooltip / Toast / Table / Badge / StatusDot / RiskBadge / EmptyState / Skeleton / LogViewer / CommandPalette 等），比"装一个库"慢。
- **没有现成的暗色主题矩阵**：需要自己定义色阶并验证对比度。
- **视觉回归基线需要维护**：截图更新要人工确认，否则会把 bug 固化成基线。

### 中性

- Tailwind v4 的 CSS-first 配置（`@theme`）恰好适合令牌单一来源，与 Solid 无耦合。
- 若将来确实需要一整套成品组件，可以整体替换 `components/ui`——因为上层只依赖它自己的 API，不依赖第三方。

---

## 4. 备选方案与被否原因

| 方案 | 否决原因 |
|---|---|
| Kobalte + solid-ui（原计划） | 2.0 适配未验证；且 solid-ui → Kobalte 两层叠加，一处不适配就全线卡住 |
| 全量引入 Ark UI（`@ark-ui/solid`） | 有官方 Solid 适配，但当前仍以 1.x 为主；为少数复杂组件引入整套依赖不划算。**保留为复杂组件的按需选项** |
| 换回 React 19 + Radix/shadcn | 生态最稳，但前端框架已定为 Solid；且任务图已自研，换框架不会减少自研量，反而推翻既有决策 |
| 继续用组件库 + 打补丁/fork | 版本地狱：升级 Solid 时要同时维护 fork，长期成本最高 |
| Storybook 作为组件工作台 | Solid 支持差、启动重；自建 `/dev/ui` 路由更快，且能直接被 Playwright 截图/Axe 复用 |

---

## 5. 未验证项

| 项 | 状态 | 计划 |
|---|---|---|
| Ark UI 在 Solid 2.0 下的可用性 | **未验证** | 仅在确实需要 combobox/date picker 时做 30 分钟 spike |
| `<dialog>` / Popover API 在目标浏览器的表现 | **未验证** | Phase 0 前跑一次 gallery，记录降级方案 |
| 18 个组件的实际工作量 | 估算 | 先做 5 个（Button/Input/Dialog/Popover/Badge）验证节奏，再铺开 |
| 深色主题对比度 | 未验证 | 令牌落地后用 axe 与对比度检查器验收 |

---

## 6. 复审触发条件

1. Kobalte 或 solid-ui 正式声明支持 Solid 2.x，且能显著减少自研量；
2. 自研组件维护成本超出预期（例如 3 个月内因交互缺陷返工 5 次以上）；
3. 产品需要复杂数据录入（日期区间、多维筛选），手写成本明显高于引入 headless SDK；
4. 设计侧要求成体系的主题市场/多品牌换肤。

---

## 7. 参考

- `docs/ARCHITECTURE.md` §2.2（选型表）、§8.6（组件层约定）、§8.7（Solid 纪律）
- `AGENTS.md`「UI 依赖白名单」
- 平台能力：`<dialog>`、Popover API、`<details>`、`@floating-ui/dom`
