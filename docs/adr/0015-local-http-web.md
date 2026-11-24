# ADR 0015：本地 HTTP + SSE + 同源 Web，token 由 daemon 注入

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** ARCHITECTURE §9/§10；PLAN M11
- **证据：** `http.test.ts`、`agentd.test.ts`、`packages/web` build、daemon smoke

---

## 1. 背景

M11 需要 Web Console，但 V1.0 的 CLI 没有 HTTP 层。Web 不能直接读 SQLite；必须有一个同源、本地、可鉴权的 API。

## 2. 决策

1. daemon 启动 Hono，默认 `127.0.0.1:7788`；只监听回环地址。
2. token 由 daemon 生成/读取 `$HUBAGENT_HOME/token`（0600）。
3. API 用 `Authorization: Bearer`；SSE 额外接受 `?token=`，因为 `EventSource` 不能设置 header。
4. daemon 同源托管 `packages/web/dist`；index.html 注入 token，供同源 UI 调用 API。
5. 首版 API 只读 tasks/evidence/decisions/agents/approvals + approval 决策；不暴露任意 SQL/文件接口。
6. Web 使用 Solid 2 + Vite；首版不引入 UI SDK，避免 beta API 阻塞可用闭环。

## 3. 后果

- 本地单用户闭环可用；无跨域/CORS。
- token 存在页面里，适合 localhost；远程/V1.1 必须改短期 token 或 HttpOnly cookie。
- 首版 Web 没有任务图/成本图表/虚拟滚动；属于可用切片，不是完整设计系统。
- SSE 当前轮询数据库 1s；后续可接进程内事件总线。
