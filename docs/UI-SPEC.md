# HubAgent Console UI 规范（v1）

- **状态：** 草案（P0 输入，随 P1 落地更新）
- **日期：** 2026-11-25
- **适用：** `packages/web`
- **决策来源：** ADR 0019、ADR 0016、ADR 0004
- **实现状态：** 未开始；本文件先于代码存在，P0 起作为验收口径

---

## 1. 设计原则

1. **Chrome 安静，数据发声。** 导航、页头、面板不抢内容的注意力。
2. **一个强调色。** 主操作用 accent；运行/待办/失败各自使用语义色，不共用一色。
3. **层级靠 tone step 与 1px 线**，静置面板不加阴影；位移与浮起只属于浮层。
4. **动效只解释状态变化**，不做装饰性入场；长列表里不逐条动画。
5. **令牌是唯一来源。** 组件内不写裸色值、字号、间距、圆角。

---

## 2. 颜色令牌

> 代码中的 CSS 变量带 `--hx-` 前缀（如 `--hx-bg-canvas`），用于与迁移前的 legacy 变量共存；Tailwind 语义名不带前缀（`bg-canvas`）。P3 删除 legacy 后统一。

### 2.1 语义角色（B · Graphite，ADR 0030）

> 主张：**chrome 全灰阶；颜色只出现在两处——产品有判决的地方（pass / fail）与「需要你」（signal 琥珀）。**
> 因此 `--accent` 不再用于主操作或“运行中”，它只表示“这件事轮到你了”。主按钮用 `--fg-default` 实底墨色。

| token | Light | Dark | 用途 | 实测对比 |
|---|---|---|---|---|
| `--bg-canvas` | `#F6F7F9` | `#0B0C0E` | 页面底 | — |
| `--bg-surface` | `#FFFFFF` | `#111316` | 面板、对话区、dock 卡片 | — |
| `--bg-subtle` | `#F1F3F6` | `#171A1E` | 证据块、代码、命令 | — |
| `--bg-hover` | `#ECEFF3` | `#1C2025` | hover 填充 | — |
| `--bg-active` | `#E5E9EE` | `#22272D` | 选中填充 | — |
| `--fg-default` | `#12151A` | `#E6E8EB` | 正文、标题 | 17.1 / 15.9 |
| `--fg-muted` | `#545B65` | `#A8AEB6` | 次级文字 | 6.40 / 8.75 |
| `--fg-subtle` | `#636B78` | `#7C848E` | 元信息（最低档） | 5.02 / 5.17 |
| `--line-subtle` | `#E4E7EB` | `#22262B` | 面板边界、表格行线 | ≈1.2 |
| `--line-default` | `#CFD5DC` | `#2E343B` | 分组线 | ≈1.4 |
| `--line-control` | `#B3BAC3` | `#3A424A` | 输入框/控件边界 | ≥3:1 |
| `--accent`（signal） | `#8A5A00` | `#F5A524` | **只表示「需要你」** | 5.53 / 9.59 |
| `--accent-hover` | `#6D4700` | `#FFBE4D` | signal hover | — |
| `--accent-soft` | `#FDF3E0` | `#2A2010` | 「等你」容器浅底 | — |
| `--success` / `--success-soft` | `#1A7F37` / `#E8F3EC` | `#3FB950` / `#10221A` | **判决通过**、完成 | ≥4.5 |
| `--warning` / `--warning-soft` | `#8A5A00` / `#FDF3E0` | `#F5A524` / `#2A2010` | 待你处理（= signal） | 5.53 / 9.59 |
| `--danger` / `--danger-soft` | `#B3261E` / `#FBECEB` | `#F85149` / `#2A1414` | **判决未通过**、拒绝 | ≥4.5 |
| `--ring` | `#8A5A00` | `#F5A524` | 焦点环（与 signal 同源） | ≥3:1 |

对比度为 2026-11-27 用 WCAG 公式实测（`contrast.py`，见 PLAN-CONSOLE-INTERACTION §3.3）。

**令牌不只颜色：动效也进令牌层**（`--hx-ease-out: cubic-bezier(.23,1,.32,1)`、`--hx-ease-drawer`、`--hx-dur-{fast,base,enter,exit}`）。内置 `ease` 太软，撑不起“有意为之”的观感。

### 2.2 使用规则

- **正文只用 `--fg-default`。** 整段灰字视为未完成状态。
- **`--fg-subtle` 只能用于 12–13px 的元信息**。实测下限来自选中行（`bg-active`）：4.60:1，刚过 AA；若背景再深一档，此档位需要重新取值。
- **边框三档：**
  - 面板/表格行：`--line-subtle`（1.2:1，靠 tone 分离即可）；
  - 分组：`--line-default`；
  - 控件：`--line-control`（≥3:1，WCAG 1.4.11）。
- **焦点：** `outline: 2px solid var(--ring); outline-offset: 2px`；输入框可用 `offset: -1px`。
- **禁止：** 渐变、发光、玻璃、彩色图标底、彩色 KPI 卡。

### 2.3 状态语义

| 业务状态 | tone | 展示 |
|---|---|---|
| `running` / `queued` / `active` | neutral（`fg-2` / `fg-3`） | 点 + 文案；**不用琥珀**——在跑不是“轮到你” |
| `waiting_approval` / `waiting_input` / `pending` / `paused` | signal（琥珀） | 点 + 文案；审批容器用 `accent-soft` 浅底 |
| `completed` / `pass` / `approved` | success | 点 + 文案 |
| `failed` / `error` / `rejected` / `blocked` | danger | 点 + 文案 |
| `idle` / `offline` / 未知 | neutral | 灰点 + 文案 |

规则：一行只能有一个状态标记；列表行用 **dot + 文字**，胶囊用于标题/详情。

---

## 3. 字体与排版

### 3.1 字体栈

```css
--font-sans:
  "Inter", "Noto Sans SC Subset", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
--font-mono:
  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

- 拉丁：**Inter Variable**（自托管，OFL 1.1），`font-optical-sizing: auto`。
- 等宽：**JetBrains Mono**（自托管，OFL 1.1），只用于 ID、命令、日志、diff。
- 中文：**Noto Sans SC 子集**（自托管，OFL 1.1）+ 系统回退。
  - 子集覆盖：`packages/web` 全部 UI 文案、CJK 标点、常用 500–800 字。
  - 用户生成内容（任务标题）若缺字，浏览器**按字形**自动回退到 PingFang SC / 微软雅黑，不需要 `unicode-range`。
  - 目标体积：UI 子集 ≤ 600KB woff2；若后续要求全中文自托管，再加 GB2312 子集（≤ 2MB），单独评审。

### 3.2 加载

- 全部 woff2 放 `packages/web/src/assets/fonts/`，`@font-face` 写在 `styles` 入口。
- Latin 与 Mono 预加载（`<link rel="preload" as="font" crossorigin>`）；CJK 子集不预加载。
- `font-display: swap`；回退字体用 `size-adjust` 校准，减少 CLS。
- 许可文本随字体一起入库（`FONT-NOTICES.txt` + `LICENSE-OFL-1.1.txt`）。
- P0 实测体积：Inter latin 48KB、latin-ext 85KB、JetBrains Mono 31KB、Noto 子集 59KB；英文首屏实际传输约 140KB。
- 中文子集**由脚本生成**：`pnpm fonts` 只报告差异，`pnpm fonts:write` 从 `packages/web/src` 提取实际用到的 CJK 字符，写入 `assets/fonts/cjk-chars.txt` 并向 Google Fonts 的 `text=` 接口取单文件变量字体（wght 400..700）。文案（含中文）改完必须重跑一次，否则新字会静默回退到系统字体。单测钉住「zh 文案 ⊆ cjk-chars.txt」。

### 3.3 字号阶梯（5 级）

| 角色 | size / line-height | 字重 | 用途 | tracking |
|---|---|---|---|---|
| Page title | 24 / 1.2 | 600 | 页面 h1 | -0.02em（CJK 0） |
| Section title | 16 / 1.35 | 600 | 面板/卡片标题、线程标题 | -0.01em（CJK 0） |
| Body | 14 / 1.55（CJK 1.65） | 400 | 正文、导航、输入 | -0.006em（CJK 0） |
| Meta | 13 / 1.45 | 400 | 时间、ID、说明、字段标签 | 0 |
| Badge | 11 / 1.3 | 500 | 状态胶囊、计数 | 0 |

- 只用 400 / 500 / 600；不再出现 700。
- 数字一律 `font-variant-numeric: tabular-nums`；表格数值右对齐。
- CJK 行高 1.65（正文），不使用负 tracking。
- **移除全局 `-webkit-font-smoothing: antialiased`**；深色面板可局部保留。

---

## 4. 空间、圆角、层级

- **间距阶梯：** 4 / 8 / 12 / 16 / 24 / 32 / 48。除此之外的数值需要理由。
- **页面留白：** 桌面 24px，≤860px 16px；面板内 16px；表格行 44px；列表行 40px。
- **圆角（3 种）：** `--radius-control: 6px`、`--radius-panel: 10px`、`--radius-pill: 999px`。
- **抬升（仅浮层）：**
  - popover：`0 8px 24px rgb(0 0 0 / 8%)` + 1px 线；
  - dialog：`0 24px 64px rgb(0 0 0 / 18%)` + 1px 线。
  - 静置卡片与面板**不加阴影**。
- **外壳：** rail 56px（纯图标，保持现状）、app bar 48px、screen head 24px/20px、断点 1100 / 860 / 560。

---

## 5. 组件契约

| 组件 | 规格 | 状态 | 备注 |
|---|---|---|---|
| Button | 32px 高，6px 圆角，13/500；primary/secondary/ghost/danger | hover / focus / disabled / loading | 一屏一个 primary |
| IconButton | 32×32；rail 40×40 | hover / active / focus | 必须有 `aria-label` |
| Field / Input | 36px 高，1px `--line-control`，6px 圆角 | focus / invalid / disabled / hint | label 在上，不用 placeholder 顶替；控件本身用 `TextInput` |
| Select | 36px，原生 `<select>` + 自绘 chevron（`SelectInput`，`appearance-none pr-9`） | 同 Field | 复杂筛选才用 `@ui-sdk/select` |
| Panel | `--bg-surface`，1px `--line-subtle`，10px 圆角，16px 内边距 | — | 不加阴影 |
| StatusDot / StatusBadge | 7px 点；胶囊 20px 高、11px 字 | — | 见 §2.3 |
| Segmented / Tabs | 30px 高，track `--bg-subtle`，active `--bg-surface` | 键盘左右 | Run/Ask、主题、语言 |
| Tooltip | 浮层 1 行，12px；`@ui-sdk/tooltip` | hover / focus | rail 图标必须有 |
| Dialog | 原生 `<dialog>` + `showModal()`；宽 400–520 | open / closing | 平台给焦点陷阱与 Esc；`:backdrop` 在 tailwind.css |
| Toast | `@ui-sdk/toast`；4s，hover 暂停 | success / error | 不做全局横幅 |
| CommandPalette | `@ui-sdk/command`；Cmd+K | 空查询 / 无结果 | 跳任务/线程/Agent |
| EmptyState | 虚线框 8px 圆角，1 句 + 1 动作 | — | 保留面板边框 |
| Skeleton | 与最终尺寸同高的灰条，无 shimmer | — | 不用渐变 |
| ThreadRow | 40px+，标题 13/500，预览 12，meta 13 | hover / active / running | dot 与首行对齐 |
| TaskRow | 两行；标题 13/500；meta 13 | hover / selected | 不显示完整 ID |
| RunSpine | 计划→执行→验收→决策，4 段 | done / active / failed / todo | 产品签名元素 |
| ApprovalCard | 标题 15/600，资源 mono 12，风险 13 | pending / resolved | 主操作 Approve 实心 |
| ThinkingTrace | 折叠面板，步骤/推理/搜索/编码 | collapsed / streaming | 数据来自真实事件 |
| ToolChips | 20px 高 chips，最多 6 + `+n` | hover | 命令、attempt、exit |
| StreamingText | 末尾 8px 淡入 + 光标 | streaming / done | 不做逐字假流 |
| PromptBar | 54px 起；Run/Ask；`@`、`/` | focus / busy | IME 安全 |
| CodeBlock / Diff | 11.5px mono，行号，unified diff | — | 替换现有 `<pre>` |
| ContextCards | 证据/验收/决策卡片 | empty / filled | 右侧 Context 栏 |

---

## 6. 动效

**允许（仅这四类）：**

| 场景 | 动效 | 时长 / 缓动 | 降级 |
|---|---|---|---|
| 加载 | 像素点脉冲 + 计时 | 1.1s 循环 | 静态点 + 文案 |
| 思考轨迹展开 | 高度 0fr→1fr + 淡入 | 160ms ease-out | 直接显示 |
| 流式文本 | 尾部 8px 淡入 + 光标闪烁 | 120ms / 1s | 直接显示 |
| 审批解决 | 卡片收拢为一行 | 160ms ease-out | 立即切换 |

**反馈（不算动效）：** hover/active 的背景、边框、透明度变化 ≤120ms；按下缩放 0.96（80ms）可选。

**禁止：** 逐条消息入场、列表高度动画、滚动联动、视差、渐变/发光、无限装饰动画。

**约束：**
- 只动 `transform` / `opacity`（进度条宽度除外）。
- 无限动画在页面不可见时暂停。
- `prefers-reduced-motion: reduce` 下全部退化为静态且不丢信息。
- 截图测试用 `data-visual-test` 冻结动画与计时器。
- 长列表 >200 条启用窗口化；流式期间不得出现 >50ms 长任务。

---

## 7. 图标

- 包：**`@lucide/solid@1.79.0`**（Solid 2 专用；不要用 `lucide-solid`，那是 Solid 1）。
- 必须按图标引入：`import Check from '@lucide/solid/icons/check'`。
- 尺寸：nav 18、inline 16、status 12；`stroke-width` 统一 **1.6**（与迁移前的手绘集同粗，整页文字与图标不打架）。
- 全部经过 `components/ui/Icon.tsx` 门面；`features/**`、`routes/**` 不直接 import 图标库。

---

## 8. 可访问性

- 正文 ≥4.5:1；控件边界 ≥3:1；焦点环可见且不被遮挡。
- 所有图标按钮有 `aria-label`；rail 有 tooltip。
- 键盘顺序遵循阅读顺序；Dialog/CommandPalette 焦点陷阱与回退。
- 状态变化使用 `aria-live="polite"`，但避免每次轮询都播报。
- `prefers-reduced-motion` 与 `forced-colors` 都要有可读呈现。

---

## 9. 验收清单（P1 起逐条打勾）

- [ ] 文案对比度全部 ≥4.5:1；控件边界 ≥3:1（脚本可测）。
- [x] 字号只有 24 / 16 / 14 / 13 / 11 五级（`text-title` / `section` / `body` / `meta` / `badge`，无任意值）。
- [x] 圆角只有 6 / 10 / 999 三种（`rounded-control` / `panel` / `full`）。
- [ ] 间距全部落在 4/8/12/16/24/32/48。（还留着少数为了与 legacy 像素对齐的任意值，如 `px-[18px]`；等旧样式彻底退役后再收。）
- [ ] 一个页面只有一个主操作；三种信号不共用一色。
- [x] Inter / JetBrains Mono / Noto SC 子集实际加载（P1 起 legacy `--font` / `--mono` 指向自托管字体）。
- [ ] 每页 axe 0 critical / serious（当前 gallery + Chat/Tasks 已覆盖）。
- [x] 视觉回归：1440 / 768 / 390 × 明暗覆盖 chat / tasks / settings / gallery。
  - **基线不入库**：`pnpm test:visual` 默认只跑 axe；像素比对要 `VISUAL_SNAPSHOTS=1`，产物写到 `tests/visual/*-snapshots/`（已 gitignore）。
  - 覆盖：`dev-ui.spec.ts`（组件画廊）+ `console.spec.ts`（Chat 与 Tasks 真实页面，mock 接口 + 固定时钟 + reduced motion）。Agents / Approvals / Settings 待补。
- [ ] 10k 消息滚动不掉帧；流式期间无长任务。
- [ ] `features/**`、`routes/**` 无 `@ui-sdk/*`、`@lucide/solid` 直接引用。
  - 当前唯一例外是 `features/dev/DevUiView.tsx`：gallery 的用途就是展示 SDK 裸行为，且已被 `import.meta.env.DEV` 从生产包剔除。P3 把它移出 `features/`（或改成只经门面）后即可勾上。

---

## 10. 迁移顺序（详见 ADR 0019）

1. **P0** 依赖与 spike：Tailwind 4.3.5、`@ui-sdk` beta.17、`@lucide/solid` 1.79.0、`/dev/ui`、3 个 Beautiful UI 移植件。
2. **P1** 字体与令牌：本文件 §2–§4 落地，截图基线。
3. **P2** 基元：`components/ui/*` 重写，门面与 gallery。
4. **P3** 页面：壳层 → Chat → Tasks → Approvals → Agents → Settings。
5. **P4** 对话动效：Loading / Thinking / Streaming / Approval / Tool Chips / Context / CodeBlock。
6. **P5** 行为：Cmd+K、Toast、窗口化、可拖拽、`@` `/`。
7. **P6** 收口：删旧 CSS、CI、文档与许可。

---

## 11. 3D 增补：Agent Office 舞台（ADR 0020）

`/agents` 的唯一形式是 3D Dispatch Floor（无 2D 降级）。HUD 沿用本文的令牌与基元；3D 部分有独立约束。

**边界：** 本文的 3D 约束只作用于 `/agents`。Agent 接入（`/registry`）是独立的 2D 配置页，不属于本节范围，见 `docs/PLAN-AGENT-ONBOARDING.md`。

### 11.1 场景色板

- 3D 颜色只从 `features/agents/office/scene/theme.ts` 的 `PALETTES` 读取；不在渲染代码散落 hex。
- 明/暗两套与 HUD 的 paper/ink 语言一致（暖纸色地面、木桌、墨色文字、琥珀强调）。
- 主题切换时重设已缓存材质颜色 + 灯光 + 网格/玻璃，不重建场景。

### 11.2 状态灯与纸旗

| 阶段 | 视觉 | HUD |
|---|---|---|
| working | 绿旗 / 台灯常亮 / 伏案 | 执行中 |
| needs-approval | 琥珀旗 / 举手 / 更亮 | 等你授权 |
| needs-input | 琥珀旗 / 举手 | 等待补充 |
| paused | 暗灯 / 靠背 / 杯子 | 已暂停 |
| degraded | 琥珀旗 / 降级折角 | 降级运行 |
| failed | 红旗 / 桌面「退回」 | 故障 |
| standby | 灰旗 / 坐在等候位 | 待命 |

- 完成（`succeeded` 由前端 diff 推导为 `done` 瞬态）：盖章 → 工单飞向 DONE 墙 → 折桌 → 离场/回 bench。
- 注意力（等待/故障）：工位纸旗/信标 + 全局横幅 + 名单高亮，不靠单一颜色区分。

### 11.3 动效白名单

- 只允许由 presence diff / 事件驱动的动作：进场、走位、弹桌、落座、举手、靠背、盖章、折桌、离场。
- **禁止**随机走动、假进度、假终端、完成后跳起/警报音等娱乐化反馈。
- 连贯性：帧间隔 p95 ≤ 20ms；位移速度方差 < 10%（时长 = 距离 / 速度）；相邻帧位移 > 0.25 世界单位即判瞬移失败。

### 11.4 reduced motion / 可访问性

- `prefers-reduced-motion: reduce`：状态直接切换，跳过走位/盖章动画，信息不丢。
- canvas 设 `aria-hidden`，交互都在键盘可达的 HUD（调度卡 / 名单 / 抽屉 / 横幅）。
- 3D-only 时的替代路径是 CLI（`hubagent agent`），不是 2D 视图。

### 11.5 unsupported

- 阻断卡：说明需要 WebGL2、列出诊断（reason / webgl2 / renderer / platform / 时间）、Retry、CLI 提示。
- 明确写出「No 2D fallback」。context lost 与预检失败同一处理；已打开的抽屉在 context lost 时保留，审批仍可提交。
