# ADR 0016：Console Web 采用自有 UI 基元、双主题与 typed i18n

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PLAN M11；WEB-CONSOLE-PLAN；ADR 0003/0004/0015
- **证据：** `packages/web` build、`preview/web-chat-v2.html`、`theme.test.ts`、`i18n.test.ts`

---

## 1. 背景

M11 首版是单文件 Solid 页面，`color-scheme: dark` 硬编码、文案散落、选中态依赖边框；Chat 入口和长任务列表会引入更多交互与状态。继续这样长会让 Web 变成第二套设计系统。

## 2. 决策

1. **UI 基元自有**：`components/ui/*` 提供 Button/IconButton/StatusBadge/Pane/Collapse 等；不引入第二套组件库，也不在 features 中直接绑定 UI SDK。
2. **暂不引入 `@ui-sdk/solid`**：ADR 0004 的行为层目标保留，但 P1 先用自己的 primitives；在 P4 前做一次 spike，若可用再通过新 ADR 替换。现在不引入 beta API，避免阻塞 Console 闭环。
3. **主题三态**：`system`（默认）/`light`/`dark`；`meta[name=color-scheme]` + `light-dark()` + `:root:has(...)`；内联脚本防 FOUC。
4. **i18n typed dictionary**：`zh-CN`/`en-US`；组件不硬编码 UI 文案；日期/数字/相对时间用 `Intl`；首版不引入 i18n 库。
5. **无边框选中**：列表/导航选中用背景、字重、图标；不使用 `outline`/`box-shadow` 作为选中装饰；`focus-visible` 仍保留可访问 outline。
6. **折叠**：桌面左右 pane 可折叠并持久化；移动端用 dialog/drawer，焦点回退；收起后保留可点击入口。
7. **长任务性能**：消息/证据 cursor 分页；>100 条或 >50KB 启用窗口化；SSE 按实体合并；流式更新 rAF 合并；日志懒加载。性能预算见 WEB-CONSOLE-PLAN §4.6。

## 3. 被否方案

- **直接上 `@ui-sdk/solid`**：Solid 2 兼容性存在但 beta；Console 需要先验证信息架构与长任务性能，UI SDK 不应成为前置依赖。
- **只用全局 `dark` class**：JS 未加载/系统切换时错误；不满足 FOUC 与系统跟随。
- **二态主题开关**：无法回到 system；三态更符合用户预期。
- **每条消息入场动画**：长列表下会放大主线程成本；只保留反馈动效。

## 4. 后果

- 需要自己维护少量 a11y/键盘 primitives；换取栈稳定和可测试性。
- UI SDK 的迁移成本保留在 P4；若 P4 决定不迁移，需要再次确认 ADR 0004 的适用范围。
- 自有 i18n 支持两语言足够；若引入复数/ICU 复杂规则，再评估 `@solid-primitives/i18n`。

## 5. 复审触发条件

- P4 前 UI SDK spike 完成；
- 需要第三种语言或复杂 ICU 复数；
- 长任务性能预算无法达标，需要更换虚拟化/渲染方案；
- 远程 Web 或多人协作进入范围。
