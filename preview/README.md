# Web Console previews

Standalone HTML previews for the Signal Console direction. Mock data only; no API calls.

## Chat v2 — theme / i18n / collapse

```bash
open preview/web-chat-v2.html
# light + Chinese:
open 'preview/web-chat-v2.html?theme=light&lang=zh'
# collapsed sidebars:
open 'preview/web-chat-v2.html?left=collapsed&right=collapsed'
# approval thread:
open 'preview/web-chat-v2.html#t2'
```

What this version adds:

- System / Light / Dark theme cycle (bottom-left moon/sun icon)
- English / 中文 toggle (language icon)
- Collapsible Threads and Context panes (buttons in conversation header)
- No decorative selection borders; selected thread uses background + weight
- Higher-contrast dark tokens; light tokens with `light-dark()`
- IME-safe Enter submit in the composer
- Inline icons for theme, language, collapse, copy

## Chat v1

```bash
open preview/web-chat.html
```

## Tasks / Agents / Approvals

```bash
open preview/web-console.html
open 'preview/web-console.html#agents'
open 'preview/web-console.html#approvals'
```

Production implementation plan: `docs/WEB-CONSOLE-PLAN.md`.

## Chat v2 visual refinements (same file)

- Composer has no decorative border; uses surface background.
- Primary actions are icon-only: Run/Ask mode, Send, New, Open task, Copy, Collapse.
- Threads and Context each have a collapse control in their header; the conversation header keeps both toggles.
- Collapsed Context exposes a clickable vertical rail.

## Agent Office — 3D dispatch floor

`preview/agent-office-3d.html`（视觉 spike，配套计划 `docs/PLAN-AGENT-OFFICE.md`）。

ES module + import map，**必须经 HTTP 打开**（`file://` 下浏览器会因 CORS 拒绝加载模块）：

```bash
python3 -m http.server 4173 --directory preview
open 'http://127.0.0.1:4173/agent-office-3d.html'
```

查询参数：

- `?theme=light|dark` —— 明/暗；
- `?freeze=1` —— 确定性快照（固定布局、固定姿态），供截图/视觉回归；
- `?motion=reduced` —— 降动效（同样信息量）；
- `?agent=claude` —— 启动后聚焦该 Agent 并打开抽屉；
- `?unsupported=1` —— 强制阻断态，用于核对「无 2D 兜底」文案。

要点：

- **3D-only**：环境不支持就显示阻断卡（WebGL2 检测 + 诊断 + `hubagent agents` 提示），不提供名单/表格兜底。
- 演示链路：工单打印 → 进门 → 空位蓝图 → 工位弹起 → 落座 → 工作 → 举手/暂停 → 盖章 → DONE 墙 → 折桌 → 离场 → bench。
- `preview/vendor/three.module.js` 是 three r169 的本地副本（MIT），只为预览离线可跑；生产由构建产物引入，不依赖 CDN。
- 截图：`preview/screenshots/agent-office-{light,dark,drawer,mobile,unsupported}.png`。

基线唯一：`preview/agent-office-3d.html`。早期那个带 2D 名单兜底的变体已删除（与本计划「环境不支持就是不支持」冲突）。
