# ADR 0025：dsh 内层沙箱关闭，外层隔离由 HubAgent 负责

状态：Accepted（2026-11-26）

## 背景

DSH 自带 `workspace-write` 沙箱，工具调用时再调用一次 `sandbox-exec`。HubAgent 已经把 Agent 进程放进自己的 srt/seatbelt 沙箱，嵌套后 dsh 报：

```
Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable
Runner failure: sandbox-exec: sandbox_apply: Operation not permitted
```

结果 dsh 的 bash/glob/read 全部 failed，任务无法完成。DSH 在 ACP profile 里用 `DSH_PERMISSION_MODE`（默认 `workspace-write`）选择内层模式。

## 决定

- dsh 的注册命令加 `DSH_PERMISSION_MODE=danger-full-access`，关闭它自己的内层沙箱；
- HubAgent 的外层沙箱仍然生效（worktree + `agent.allowedWrite`，如 `~/.dsh`），网络仍按 agent-managed/白名单；
- 目录内置变体与迁移 015 同时更新，已有 dsh 注册在下次启动时自动加前缀；
- catalog notes 明确这是「外层隔离」模型，避免被理解成完全无沙箱。

## 被否方案

- 让 HubAgent 对 dsh 不做沙箱（fail-open）：违反“所有子进程必须经 SandboxProvider”的底线。
- 让 dsh 用 read-only 内层：仍然会嵌套调用 sandbox-exec，问题不变。
- 要求用户手工改命令：升级后容易忘，体验差。

## 后果

- dsh 的工具调用恢复；内层审批策略变为 never，但外层 HubAgent 仍会拦截越界写。
- 其他自带沙箱的 Agent 若出现同样 `sandbox_apply`，按同一模式处理。
