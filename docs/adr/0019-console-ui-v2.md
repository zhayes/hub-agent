# ADR 0019：Console UI v2 —— Tailwind v4 令牌层 + `@ui-sdk` 行为层 + Beautiful UI 视觉移植

- **状态：** 已接受（Accepted）；P0 已通过（2026-11-25）
- **日期：** 2026-11-25
- **相关：** ADR 0003 / 0004 / 0016 / 0017；`docs/UI-SPEC.md`；`docs/WEB-CONSOLE-PLAN.md`
- **证据：** 现有 `packages/web/src/styles.css` 的实测数据（对比度、字号/圆角/间距分布）、npm 元数据、`beautifului.dev` 与其镜像源码

---

## 1. 背景

ADR 0004 已决定 UI 采用「`@ui-sdk` 行为层 + 自研视觉 + Tailwind v4」，但 ADR 0016 为优先关闭 Console 闭环，把该条款推迟到 P4，P1 先用自己的 primitives 与手写 CSS。

现状（M11 收口后）暴露出的不是"缺组件"，而是**视觉契约不成立**：

| 指标 | 实测 | 后果 |
|---|---|---|
| 字号 | 10 级（11 / 11.5 / 12 / 13 / 14 / 15 / 19 / 20 / 22 / 24） | 没有层级，观感"毛" |
| 圆角 | 8 种 | 视觉噪声 |
| 内边距 | 约 30 种 | 节奏散 |
| `--faint` 对比度 | **4.30:1** on ground | 低于 AA，时间戳发虚 |
| 输入框边框 | **1.77:1** | 控件边界不可辨 |
| 面板线 | 1.21–1.44:1 | 结构"发灰" |
| 强调色使用 | 运行中 / 待审批 / 主操作共用橙 | 信号不分离，重点消失 |
| 字体 | 声明 IBM Plex 但未加载 | 实际 system-ui，13px 偏细 |

同时，`beautifului.dev` 提供了一套高度契合本产品的 AI-native 组件（loading、thinking、streaming、approval、tool chips、task rows、prompt bar、context cards、code block）。核查结论：**React 19 + Tailwind v4 的 copy-paste 组件，MIT，无 motion 依赖，自播放 demo，不能直接安装进 Solid**。

产品负责人已拍板：B 暖墨色板、自托管字体（Inter + JetBrains Mono + 中文子集）、本期引入 `@ui-sdk`、左栏保持纯图标、视觉回归进 CI、对话动效只覆盖加载/思考/流式/审批解决。

## 2. 决策

1. **Tailwind v4 作为工具层，不替代令牌。**
   - `tailwindcss@4.3.5` + `@tailwindcss/vite@4.3.5`（peer 已支持 Vite 8）。
   - 令牌用 CSS 变量 + `light-dark()`；通过 `@theme inline` 暴露为语义 utilities（`bg-surface`、`text-ink-2`、`border-line`）。
   - 保持 `meta[name=color-scheme]` 三态主题，不改为 Tailwind 的 `dark:` 单一来源。
2. **`@ui-sdk/core` + `@ui-sdk/solid@0.1.0-beta.17` 本期引入，仅用于行为层。**
   - 首批：`dialog`、`popover`、`tooltip`、`menu`、`select`、`command`、`toast`、`segmented-control`、`scroll-area`、`resizable`、`timeline`。
   - 视觉全部自写；不采用 SDK 的示例样式。
   - **精确锁版本**；升级单独 PR + 基元截图回归。
3. **图标改用 `@lucide/solid@1.79.0`（Solid 2 专用）。**
   - 更正 ADR 0004 白名单中的 `lucide-solid`：那是 Solid 1 包。
   - 必须按图标引入（`@lucide/solid/icons/*`），经 `components/ui/Icon.tsx` 门面。
4. **门面强制。** `features/**`、`routes/**` 只能 import `components/ui/*`；禁止直接 import `@ui-sdk/*` 与 `@lucide/solid`。
5. **Beautiful UI 作为视觉与动效参考，不引入其代码为运行时依赖。**
   - 只移植结构、class 语义、keyframes 与交互规格；组件外壳用 Solid 重写。
   - 其组件是"自播放 demo"，必须改为真实状态驱动（`thread.status` / `messages` / `approvals` / `executions`），**禁止假流与假进度**。
   - 首批只做 7 个：Loading、Thinking、Streaming、Approval、Tool Chips、Context Cards、CodeBlock/Diff。
   - MIT：保留版权声明，新增 `THIRD-PARTY.md`。
   - 不引入 `glimm` / `liveline` / `iconoir-react`。
6. **动效白名单（取代 ADR 0016 的概括性表述）。**
   - 只允许：加载脉冲、思考轨迹展开、流式尾部揭示、审批解决收拢。
   - 禁止：逐条消息入场、列表高度动画、滚动联动、渐变/发光、无限装饰动画。
   - 无限动画离屏暂停；`prefers-reduced-motion` 全部退化；截图测试冻结动画与计时器。
7. **视觉回归与 a11y 进 CI。**
   - Playwright 截图：1440 / 1024 / 768 / 390 × 明暗；固定容器、冻结时钟、遮罩动态值。
   - `@axe-core/playwright`：critical / serious 直接失败。
   - 基线按平台后缀保存**并随代码入库**（当前仅 `-darwin`，8 张约 1.5 MB）；CI 的 `visual (macos)` job 跑同一套 darwin 基线，失败时把 actual/diff 作为 artifact 上传。
   - 更新基线：在 macOS 上 `pnpm test:visual:update`，人工确认 PR 里的图片 diff 后再提交。非 macOS 环境由 `ignoreSnapshots` 跳过比对，只跑 axe。
   - 基线增长须控制：每页一套（1440 / 768 / 390 × 明暗）；新增页面时同步评估是否需要减宽度或改用局部元素截图。
   - 首跑（2026-11-25）runner 与本机基线像素一致，因此该 job 保持阻塞；job 内打印 `sw_vers`，日后镜像漂移时可据此钉版本或重出基线。
8. **左栏保持 56px 纯图标 rail。**
   - 以 tooltip、计数、`aria-label` 与快捷键补足可发现性；不改为文字侧栏。

## 3. 被否方案

| 方案 | 否决原因 |
|---|---|
| 继续手写 CSS，只换颜色/字体 | 能改善观感，但不解决一致性与回归成本；令牌仍会漂移 |
| 直接把 Beautiful UI 的 React 代码接进来 | 框架不兼容；且它们是自播放 demo，不是数据驱动 API |
| 引入整套成品组件库（Ant Design / MUI / shadcn 全套） | 与 ADR 0003 冲突；会形成第二套设计系统 |
| 用 `lucide-solid`（Solid 1 包） | peer 为 `solid-js ^1.4.7`，与 Solid 2 不匹配 |
| 中文只走系统字体 | 负责人要求自托管子集；跨平台与截图确定性需要 |
| 保留 Tailwind 默认色板 | 与 B 暖墨令牌冲突，会回到"模板脸" |
| 一次性全量迁移 | 5 个页面同时改，回归面不可控；采用一页一 PR |

## 4. 后果

### 正面

- 字体、色阶、尺度、边框、状态都有唯一来源，**"改美观"变成改变量**。
- 复杂行为（dialog/select/command/toast/窗口化）不再自研，a11y 有基线。
- 图标与许可口径统一到官方 Solid 2 包。
- 视觉回归把"改一处坏一处"变成可发现的问题。

### 负面（已接受）

- 双栈过渡期：旧 CSS 与新 utilities 会短期并存，必须按页删除。
- `@ui-sdk` 仍是 beta：锁版本 + 门面 + 截图回归，升级有成本。
- 中文子集需要构建步骤与字体许可文件；用户生成内容依赖系统回退。
- 视觉回归基线需要人工确认，CI 时间增加。
- `@lucide/solid` 包体解压约 59MB（按图标引入后产物很小，但安装/类型检查变慢）。

### 中性

- Tailwind 是工具层，不构成"第二套设计系统"。
- 动效白名单比 ADR 0016 更精确，长列表成本可控。

## 5. P0 验证（任一不通过则触发复审）

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | Tailwind 4.3.5 + Vite 8 + Solid 2 | 构建通过，`light-dark()` 与 `@theme inline` 生效 |
| 2 | `@ui-sdk` beta.17 | Dialog + Select + Command + Toast 可用；无样式渗漏 |
| 3 | `@lucide/solid@1.79.0` | 3 个图标按需引入；类型检查通过；产物增量可接受 |
| 4 | Beautiful UI 移植 3 件 | Loading / Approval / Streaming 由真实状态驱动，视觉达标 |
| 5 | a11y | axe 0 critical / serious |
| 6 | 视觉回归骨架 | 3 宽度 × 明暗可稳定出图；无 flaky |
| 7 | 长列表 | 1 万条消息窗口化后滚动流畅 |
| 8 | 体积 | 记录基线；新增 gzip 预算需给出数字 |

**P0 结果（2026-11-25）：** 8 项中 7 项通过；第 7 项结论为 SDK 无独立 virtualizer，暂用 `content-visibility`（1 万行 commit 402–616ms），P5 自建窗口化。主 JS 118.70 kB（与改造前持平），CSS 46.07 kB，字体总计 219 kB / 首屏英文 140 kB，axe 0 critical/serious，8 张视觉基线通过。详见 `docs/UI-P0-REPORT.md`。

## 6. 实施顺序与门禁

| 阶段 | 内容 | 门禁 | 估时 |
|---|---|---|---|
| P0 | 依赖、Tailwind、SDK 基元、3 个移植件、视觉回归骨架 | §5 全通过 | 1.5d |
| P1 | B 令牌、Inter/JetBrains/Noto 子集、5 级字号、边框、焦点 | 对比度单测 + before/after | 2d |
| P2 | `components/ui/*` 重写 + gallery | axe + 截图 + CSS 体积下降 | 3d |
| P3 | 页面迁移（一页一 PR） | 每页 e2e + 8 张基线 | 5d |
| P4 | 对话动效 7 件 | 性能预算 + reduced-motion | 2d |
| P5 | Cmd+K、Toast、窗口化、可拖拽 | 10k 消息 + 键盘 | 2d |
| P6 | 删旧 CSS、CI、文档、许可 | `pnpm verify` + e2e + visual + axe | 1d |

**P4 / P5 落地记录（2026-11-25）：**

- **Streaming 是消息级，不是 token 级。** hub 不产生 LLM token 流：助手消息在建任务 / 待审批 / 待澄清 / 结束这些离散点一次性写入。因此 `GET /api/v1/chat/threads/:id/stream`（SSE，游标为 `rowid`）推的是整条消息，前端把光标只放在**运行中线程的最后一条**上。不伪造逐字流。
- **Thinking 绑定 plan，不绑 CoT。** 运行时只持久化计划，所以展开件展示 `kind: 'plan'` 的内容，标题用 `stepPlan`。不存在链式思考数据，也不去造它。
- **Tool Chips 绑定“已记录的效果”，不是工具名。** hub 不持久化原始工具调用，chips 因此渲染消息携带的结构化引用（task / approval / clarification），并链到任务页。要展示真实工具名，得先在 hub 侧落地工具调用记录。
- **Diff 视图未做。** diffstat 只在任务详情（`executions.evidence`）里有数据，聊天侧没有对应载荷；等 P4 之后单独补。
- **窗口化放弃（有据）。** 试过消息行加 `content-visibility: auto`，视觉回归在手机视口出现 6% 像素偏移（固有尺寸改变滚动锚点），已回滚。聊天按 100 条分页，DOM 只随用户主动翻页增长；真正要窗口化时需阈值开关 + 定高消息的限定范围。

**P5 落地记录（2026-11-25）：**

- **Cmd+K**（`components/ui/CommandPalette.tsx`）：SDK 的 command 装在 dialog 内，过滤 / roving focus / Esc / 焦点归还都归 SDK；关闭走 `onFlush`，避免与导航争 owned scope。
- **Toast**（`components/ui/Toaster.tsx`）：模块级单 toaster，壳层挂一次；审批决定成功后提示（`store.decide` 与聊天内 `decideApproval` 都覆盖）。文案复用 `approve` / `reject` 两个已有 key，不新增中文，子集无需重生成。
- **可拖拽分栏**：左右栏宽存 state + localStorage（220–460px），拖拽用 pointer capture，键盘用 `role="separator"` + 方向键（Shift 加速），≤860px 仍走单列（内联宽度只在 ≥861px 应用）。手柄默认透明，不影响基线。
- **`/` 与 `@`**：`/` 列命令（run / ask / new / context），`@` 列任务并按标题或 id 过滤；菜单由输入文本派生，不存平行状态，方向键 + Enter 选择、Esc 清空。列表用 `role=listbox` + `option`，焦点不离开输入框（所以选项是 `tabindex=-1`）。

**体积实测（生产包，raw / gzip）：** 主包 286.52 / 97.36 kB，命令面板单独成块 55.54 / 19.78 kB（首次 ⌘K 才加载）。SDK 的弹层基础是主要成本：只挂 Toast 大约 +83 kB，移除它主包回到 203.22 kB。若要再压，下一步是把 Toast 也改成按需（需一个待发队列避免首次提示丢失）。

## 7. 复审触发条件

1. `@ui-sdk` beta 出现影响 Dialog/Select/Command 的破坏性变更；
2. P0 任一项不通过（回退到 ADR 0003 的纯平台原语方案，不视为失败）；
3. 中文字体子集导致缺字或体积超标，需要改为系统字体或全量字体；
4. 视觉回归长期 flaky，抵消其价值；
5. 产品要求文字侧栏或第三套主题，需要重新评估 shell 与令牌。

## 8. 参考

- `docs/UI-SPEC.md`（令牌、字号、间距、组件契约、动效白名单）
- ADR 0004（行为层与门面）、ADR 0016（三态主题、i18n、长列表约束）
- `@ui-sdk/solid@0.1.0-beta.17` npm 元数据（peer `solid-js ^2.0.0`）
- `@lucide/solid@1.79.0` npm 元数据（peer `solid-js ^2.0.0-rc.0`，仅 Solid 2）
- beautifului.dev（MIT）；镜像 `TurboKach/ai-native-react-components`
- Tailwind CSS v4.3.5（`@theme inline`、`@tailwindcss/vite` peer `vite ^5 || ^6 || ^7 || ^8`）
