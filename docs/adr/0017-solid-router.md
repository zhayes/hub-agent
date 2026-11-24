# ADR 0017：Console Web 使用 @solidjs/router 2，不使用显示/隐藏切页

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** WEB-CONSOLE-PLAN §7；ADR 0016
- **证据：** `packages/web/src/app/router.tsx`、web typecheck/build、`/tasks` smoke

---

## 1. 背景

首版用一个 `view` signal 加 `<Show>` 切换 Tasks/Agents/Approvals。继续追加 Chat、Task detail、Settings 后，这种写法会失去 URL、深链、浏览器前进后退和将来嵌套页面能力，也会让状态分散在单个 App 组件里。

## 2. 决策

1. 使用 `@solidjs/router@2.0.1`；它与 Solid 2 / `@solidjs/web` 的 peer 匹配。
2. 路由是单一路由表：`/tasks`、`/tasks/:id`、`/agents`、`/approvals`、`/settings`，404 fallback。
3. 页面通过 `<a href>` 和 `useNavigate` 导航，不再用 `window.history.pushState` 手工伪造，也不再用 `Show` 做页面切换。
4. `AppProvider` 只提供跨路由的数据/主题/i18n/连接状态；路由组件读 context，不把整个 App 状态塞进 layout。
5. `AppLayout` 作为根 section，负责 rail/topbar/token gate；路由 children 通过 router 注入。

## 3. 被否方案

- **继续 `<Show>` 切页**：无 URL/深链/回退；后续追加 Chat 和详情页会变成条件嵌套。
- **手写 history 路由**：可用但重复 router 的匹配、嵌套、a11y 和 preload 能力。
- **`@solidjs/router` 0.x**：peer 不匹配 Solid 2；不引入。

## 4. 后果

- bundle 增加约 27KB gzip（router + route modules）；对本地 console 可接受。
- 后续 Chat 路由可直接用 `/chat/:threadId`，不破坏 Tasks 深链。
- 需要保持 `AppProvider` 与路由生命周期解耦，避免 token/SSE 在每次导航重建。

## 5. 复审触发条件

- 需要服务端渲染或 file-system routing；
- router 2 与 Solid 2 升级不兼容；
- 路由数量增长到需要 lazy route subtrees。
