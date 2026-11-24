# ADR 0004：UI 层采用 UI SDK 行为层（`@ui-sdk/solid`），视觉自研

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-23
- **取代：** ADR 0003 中「组件基座采用平台原生原语 + 完全自研」的条款（其余条款继续有效）
- **相关：** ARCHITECTURE §2.2 / §3.1 / §8.6 / §8.7；AGENTS.md「UI 依赖白名单」

---

## 1. 背景

ADR 0003 的结论是：不用整套组件库，以 `<dialog>` / Popover API / `<details>` 等平台原语自研，以避开 Solid 2.0 的生态适配问题。

这个判断有一半是对的（避开 1.x 生态是对的），但有一个遗留成本被低估了：

**真正难写的不是"弹层"和"开关"，而是行为层。** 我们实际需要手写的是：

- 上万行日志/事件的虚拟滚动；
- 命令面板的 roving focus + typeahead；
- 多选下拉（选 Agent / 选项目）的 listbox + selection + 键盘导航；
- 日期区间的 calendar 与输入解析；
- 任务图画布的平移缩放。

这些正是自研最容易出错、也最容易被 axe 与用户同时发现的地方。

用户指出 [`ui-sdk.dev`](https://ui-sdk.dev/)（`vercel-labs/ui`）正是把这一层抽象成可复用 behavior 的库，且**原生面向 Solid 2.0**。

---

## 2. 证据（实测元数据，非推测）

`@ui-sdk/solid@0.1.0-beta.13`：

```json
"peerDependencies": {
  "solid-js": "^2.0.0",
  "@solidjs/web": "^2.0.0",
  "@ui-sdk/core": "^0.1.0-beta.13"
}
```

| 项 | 事实 |
|---|---|
| 仓库 | `github.com/vercel-labs/ui` |
| npm maintainer | `shadcn`（m@shadcn.com） |
| 许可证 | Apache-2.0，附 SLSA provenance |
| 版本 | `0.1.0-beta.13`（beta；文档声明 API 可能变更） |
| 周下载 | `@ui-sdk/react` ≈ 59.8 万；`@ui-sdk/solid` ≈ 1.24 万 |
| 形态 | headless / unstyled；60+ 子路径导出（dialog / popover / menu / select / combobox / listbox / command / calendar / date-picker / tree / resizable / toast / accordion / tabs / toolbar / carousel / pagination / otp-input / color-picker / number-input …） |
| Agent 配套 | 包内 `docs/llms.txt`；官方 skill：`npx skills@latest add vercel-labs/ui --skill ui-sdk` |

关键点：**它要求的 peer 是 `solid-js ^2.0.0`**，而不是 1.x。ADR 0003 依据的"UI 库普遍卡在 1.x"这一前提，对这个库不成立。

---

## 3. 决策

1. **行为层采用 `@ui-sdk/core` + `@ui-sdk/solid`**，替换 ADR 0003 中"完全自研"的组件基座条款。
2. **视觉层仍然自研**：unstyled + Tailwind v4 `@theme` 令牌；不引入任何成品设计系统。
3. **UI 依赖白名单更新为**：`tailwindcss`、`@ui-sdk/core`、`@ui-sdk/solid`、`lucide-solid`。`@floating-ui/dom` 不再单列（定位由 SDK 的 popup 行为提供；若实测缺失再单独补）。
4. **门面封装（强制）**：`features/**`、`routes/**` 只允许 import `components/ui/*`，**禁止直接 import `@ui-sdk/*`**。
5. **精确锁版本**：`"0.1.0-beta.13"` 而非 `^0.1.0-beta.13`；升级必须单独提交并跑 gallery 截图比对。
6. **优先用 behavior 组装，其次用它的成品组件**：`createPopup` / `createSelection` / `createTypeahead` / `createVirtualizer` 等。
7. **保留三道回归网**：`/dev/ui` gallery + Playwright 截图 + `@axe-core/playwright`。

---

## 4. 后果

### 正面

- **正面解决 Solid 2.0 适配问题**：不是"绕过生态"，而是"换了一个原生支持 2.0 的生态"。
- **省掉最贵的自研**：虚拟滚动、typeahead、roving focus、listbox、calendar 都由行为层提供，且带 a11y 语义。
- **与"AI 写代码"目标同向**：这个库的核心卖点就是让 agent 用行为组装组件，并附带 `llms.txt` 与 skill；与我们的 §2.4 选型标准（语料密度、失败是否"吵"）高度一致。
- **仍然未被视觉锁定**：unstyled，样式完全在我们手里。

### 负面（已接受）

- **beta 风险**：`0.1.0-beta` 期间 API 可能变更。缓解 = 锁版本 + 门面 + 截图回归。
- **双新叠加**：Solid 2.0（新编译器 `@solidjs/compiler`、新 Vite 插件 `@solidjs/vite-plugin`）+ SDK beta。两者同时出问题的排查成本会叠加。
- **行为层意味着"组装成本"**：拿到的是零件，不是成品；对 20 屏级别的控制台可以接受，但初期搭建速度慢于"装一个组件库"。
- **生态资料少**：遇到边缘问题时，可搜到的答案远少于 Radix/shadcn。

### 中性

- 未覆盖的能力仍需自建：任务图（DAG 渲染，可能部分复用 `createViewport`）、图表（ECharts 不变）、图标（lucide-solid 不变）。

---

## 5. 被否方案

| 方案 | 原因 |
|---|---|
| 维持 ADR 0003（纯平台原语自研） | 平台原语解决"弹层/开关"，但解决不了虚拟滚动、typeahead、listbox 键盘导航；这些正是最容易出 a11y 缺陷的地方 |
| Kobalte / solid-ui | 面向 Solid 1.x；2.0 适配未验证，且 solid-ui 叠在 Kobalte 之上 |
| 全量 Ark UI | 同样面向 1.x；且我们需要的是 behavior 粒度，不是整套组件 |
| 只用 UI SDK 的成品组件、不做门面 | beta 期 API 变更会直接穿透到 `features/`，返工面过大 |
| 换回 React 生态 | 推翻框架决策，且任务图与图表已按 Solid 设计 |

---

## 6. 待验证（1 天 spike，进 Phase 0）

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | Solid 2 + `@ui-sdk/solid` 在 Vite 下能启动 | gallery 页面正常渲染 |
| 2 | 用 behavior 组装一个 Select + 一个 Dialog，套 Tailwind 类 | 视觉可控、无默认样式渗漏 |
| 3 | 键盘导航 + `@axe-core/playwright` | 零 critical / serious |
| 4 | `createVirtualizer` 渲染 10k 行事件列表 | 滚动流畅、无内存暴涨 |
| 5 | 打包体积（对比同功能手写） | 增量可接受 |
| 6 | `createViewport` 能否支撑任务图平移缩放 | 能则复用，不能则保留 d3-zoom |

任一项不通过，回到 ADR 0003 的纯平台原语方案（保留其结论，不视为失败）。

---

## 7. 复审触发条件

1. SDK 发布 1.0（锁版本策略可放松，门面可减薄）；
2. beta 期间出现影响核心界面（任务图/日志/审批）的破坏性变更；
3. spike 任一项不通过；
4. `@ui-sdk/solid` 停止维护或明确放弃 Solid 2 支持。

---

## 8. 参考

- https://ui-sdk.dev/docs（Quickstart、Core、Build a Component、Skills）
- `@ui-sdk/solid@0.1.0-beta.13` npm 元数据（peerDependencies / exports / license）
- `docs/ARCHITECTURE.md` §2.2、§8.6、§8.7
- ADR 0003（平台原语方案，本 ADR 仅取代其组件基座条款）
