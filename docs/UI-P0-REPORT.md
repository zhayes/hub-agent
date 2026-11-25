# UI P0 spike 报告

- **日期：** 2026-11-25
- **范围：** Tailwind v4 + `@ui-sdk` + `@lucide/solid` + 字体自托管 + 视觉回归骨架
- **结论：** **通过**，可进入 P1（视觉基座）
- **相关：** ADR 0019、`docs/UI-SPEC.md`、`THIRD-PARTY.md`

---

## 1. 依赖锁定

```jsonc
"dependencies": {
  "@ui-sdk/core": "0.1.0-beta.17",
  "@ui-sdk/solid": "0.1.0-beta.17",
  "@lucide/solid": "1.79.0"
},
"devDependencies": {
  "tailwindcss": "4.3.5",
  "@tailwindcss/vite": "4.3.5",
  "@axe-core/playwright": "4.10.2" // 根 workspace
}
```

Vite 配置增加了 `optimizeDeps.exclude: ['@ui-sdk/core']`（SDK 文档要求，否则开发时两份 core 冲突）。

## 2. 验证结果

| # | 验证项 | 结果 |
|---|---|---|
| 1 | Tailwind 4.3.5 + Vite 8 + Solid 2 | ✅ 构建通过；`light-dark()` + `@theme inline` 生效 |
| 2 | `@ui-sdk` Dialog / Select / Command / Toast | ✅ 四个组件可用；无样式渗漏 |
| 3 | `@lucide/solid` 按图标引入 | ✅ 类型与构建通过 |
| 4 | Beautiful UI 三件移植 | ✅ Loading / Streaming / Approval，均由显式 props 驱动 |
| 5 | axe（gallery） | ✅ 0 critical / 0 serious |
| 6 | 视觉回归骨架 | ✅ 4 宽度 × 2 主题，8 张基线 + axe，共 9 测试 |
| 7 | 长列表 | ⚠️ SDK **没有独立 virtualizer**；`content-visibility` 下 1 万行 commit 402–616ms，P5 需自建窗口化 |
| 8 | 构建体积 | 见 §3 |

## 3. 指标

| 指标 | 改造前 | P0 后 | 说明 |
|---|---|---|---|
| 主 JS | 118.02 kB (gzip 40.97) | **118.70 kB (gzip 41.19)** | 生产主包基本不变 |
| CSS | 27.25 kB (gzip 5.74) | **44.70 kB (gzip 9.53)** | Tailwind theme/utilities；gallery 类名被扫描进产物，P3 收窄 |
| 字体总量 | 0 | **224 kB**（4 个 woff2） | Inter 48+85、Mono 31、Noto 子集 59 |
| 英文首屏字体实际传输 | — | **140 kB** | Inter latin + Mono + Noto 子集（有中文时） |
| 10k 行 commit | — | **402–616 ms** | `content-visibility` 只能省绘制，不能省 DOM 创建 |

字体加载验证（Playwright）：

```json
{ "inter": true, "mono": true, "cjk": true,
  "assets": [48732, 31640, 59536] }
```

## 4. 关键发现

1. **`@solidjs/router` 的 `lazy` 路由会把主包顶大 ~46 kB。**
   改用静态导入 + `if (import.meta.env.DEV)` 注册后，生产主包回到 118.70 kB，gallery 被完全 tree-shake。
2. **不引入 Tailwind preflight 是对的，但原生 input 需要显式 `border-0`。**
   Command 输入框在 gallery 里露出 UA 边框；已在样例中修正，P2 的 Field/Input 基元必须内置 reset。
3. **SDK 没有通用 virtualizer。**
   `Select`/`Combobox` 支持数据驱动虚拟列表，但聊天消息需要自建窗口化（P5）。`content-visibility` 可作为过渡，但不能解决首次创建 1 万节点的成本。
4. **字体体积可控。**
   中文按 UI 字符集生成 214 字子集（58 kB）；用户生成内容回退系统 CJK。Inter latin-ext 仅在遇到扩展拉丁字符时加载。
5. **视觉回归必须按平台存基线。**
   当前基线为 `-darwin`，随代码入库（8 张约 1.5 MB）；CI 用 `macos-latest` 跑同一套基线，失败时上传 actual/diff。若将来迁到 Linux 容器，需在容器内重新生成 `-linux` 基线并成对入库。非 macOS 环境由 `ignoreSnapshots` 跳过比对，只跑 axe。
6. **Playwright 默认 `threshold: 0.2` 会吞掉整块底色改动。**
   把卡片底部条从 `#181614` 改到 `#0e0d0c`（每通道约 4%）时，默认阈值判定像素相同，diff 为 0，`--update-snapshots` 也认为无变化，基线停在旧值上而测试全绿。现改用 `threshold: 0.05`；成片改色后若基线没动，用 `--update-snapshots=all` 强制重写。
   同源问题：视觉配置不再 `reuseExistingServer`，否则复用到一个跑着旧 CSS 的 dev server 会让 actual 恰好等于旧基线，同样假通过。

## 5. 产出的代码

| 文件 | 作用 |
|---|---|
| `packages/web/src/styles/layers.css` | 级联层顺序：legacy → ui-sdk → theme → utilities |
| `packages/web/src/styles/tokens.css` | `--hx-*` 语义色（B 暖墨） |
| `packages/web/src/styles/tailwind.css` | Tailwind 入口、`@theme`、字体栈、语义色映射 |
| `packages/web/src/styles/fonts.css` | 4 个自托管 `@font-face` |
| `packages/web/src/styles/motion.css` | 加载脉冲 / 光标 / `content-visibility` 探针 |
| `packages/web/src/components/ui/{LoadingState,StreamingText,ApprovalCard}.tsx` | Beautiful UI 移植件（MIT） |
| `packages/web/src/components/ui/button-classes.ts` | P0 阶段共享按钮样式 |
| `packages/web/src/features/dev/DevUiView.tsx` | `/dev/ui` gallery（仅 dev） |
| `packages/web/src/assets/fonts/*` | woff2 + OFL 文本 + 字符集 |
| `tests/visual/dev-ui.spec.ts` | 8 张基线 + axe |
| `playwright.visual.config.ts` | 视觉回归配置 |
| `.github/workflows/ci.yml` | 新增 `visual (macos)` job |

## 6. 复现

```bash
pnpm dev:web           # 打开 http://127.0.0.1:5173/dev/ui
pnpm test:visual       # 比对基线 + axe
pnpm test:visual:update
pnpm build:web
```

## 7. P1 输入

1. 把 `packages/web/src/styles.css` 按页拆解，逐步删掉 legacy 层。
2. 在 `components/ui` 落 Button / Field / Panel / StatusBadge / Tabs 五个基元。
3. 把 gallery 的 Tailwind 类名收窄到 dev-only CSS（或 P3 删除 gallery），避免生产 CSS 为未使用类付费。
4. 中文字体子集在 i18n 文案变动后需要重新生成：`cjk-chars.txt` + Google Fonts `text=` 接口。
