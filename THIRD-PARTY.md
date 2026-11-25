# Third-party notices

本仓库包含或计划包含以下第三方作品。分发时请保留对应许可与版权声明。

| 作品 | 许可 | 用途 | 需要随附 |
|---|---|---|---|
| [Inter](https://github.com/rsms/inter) | SIL Open Font License 1.1 | UI 拉丁字体（自托管 woff2） | `packages/web/src/assets/fonts/FONT-NOTICES.txt`、`LICENSE-OFL-1.1.txt` |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 | ID / 命令 / 日志等宽字体（自托管 woff2） | 同上 |
| [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) | SIL Open Font License 1.1 | 中文 UI 子集（自托管 woff2，由 `pnpm fonts:write` 生成） | 同上 |
| [Lucide](https://lucide.dev)（`@lucide/solid`） | ISC | 图标 | `THIRD-PARTY.md` 本文件 |
| [@ui-sdk](https://ui-sdk.dev)（`@ui-sdk/core`、`@ui-sdk/solid`） | Apache-2.0 | 行为层（dialog / select / command / toast 等） | 依赖包自带 LICENSE |
| [Tailwind CSS](https://tailwindcss.com) | MIT | 样式工具层 | 依赖包自带 LICENSE |
| [Beautiful UI](https://www.beautifului.dev) | MIT | 对话界面的视觉与动效参考；部分结构/CSS keyframes 移植 | 本文件 + 源文件头部注释 |
| [Solid](https://www.solidjs.com)（`solid-js`、`@solidjs/web`、`@solidjs/router`） | MIT | 前端框架 | 依赖包自带 LICENSE |

## Beautiful UI

- 原作者：Shane Levine / Turbo Product（beautifului.dev）。
- 许可：MIT。参考镜像：`TurboKach/ai-native-react-components`（19 个组件，注明来源 beautifului.dev，MIT）。
- 使用方式：本项目**不引入其运行时依赖**，只按 MIT 条款移植结构与 CSS keyframes，并用 Solid 重写组件外壳、接入真实状态。
- 移植文件顶部需保留：

```text
Portions derived from Beautiful UI (https://www.beautifului.dev), MIT License.
Copyright (c) Beautiful UI / Turbo Product.
```

## 字体说明

- 字体文件已在 `packages/web/src/assets/fonts/` 入库，并附 `FONT-NOTICES.txt` 与 `LICENSE-OFL-1.1.txt`。
- Inter 提供 latin / latin-ext 两个 woff2；JetBrains Mono 提供 latin；Noto Sans SC 为 **UI 字符子集**（`cjk-chars.txt`，由 `pnpm fonts:write` 从 `packages/web/src` 提取后重新下载），用户生成内容缺字时由系统字体回退。
- 子集重生成：改动 `src/**` 中文文案后，重新提取 CJK 字符，再走 Google Fonts 的 `text=` 接口；步骤见 `docs/UI-SPEC.md` §3.2。
- 若后续替换字体，必须同步更新本文件、`docs/UI-SPEC.md` 与字体目录内的许可文件。

## 维护规则

- 新增任何复制进仓库的第三方代码、字体或图标，先在此登记，再提交。
- 只引用依赖包、不复制源码的，保留包内 LICENSE 即可，无需在此逐条展开。
