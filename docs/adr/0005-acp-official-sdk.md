# ADR 0005：ACP 采用官方 TypeScript SDK，客户端不暴露宿主文件系统/终端能力

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §6.4 / §18.9；ARCHITECTURE §7.1；PLAN M4
- **证据：** `packages/hub/test/unit/acp-client.test.ts`、`acp-run.test.ts`；`pnpm hubagent run` 真实 srt + mock ACP Agent

---

## 1. 背景

M4 要跑通 `initialize → session/new → session/prompt → session/update → 结果`。核心不确定性不在业务逻辑，而在协议细节：

- JSON-RPC 行分帧、粘包、并发请求 ID、错误响应、通知；
- ACP v1 的 schema 较大且仍在演进；
- stdio 外层还有 `AgentHost` 与 srt shell 包装，分帧不能想当然。

ARCHITECTURE §2.3 已定"优先官方 ACP TS SDK；否则自研行分帧层"。官方 `@agentclientprotocol/sdk` 提供 ACP v1 schema、`ndJsonStream` 与客户端连接层，因此不再手写一套 JSON-RPC。

## 2. 决策

1. **使用 `@agentclientprotocol/sdk@2.9.1`（精确锁版本）**，只使用稳定 v1 入口；不引入 experimental 子路径。
2. **分工固定**：`AgentHost` 负责子进程生命周期、stdout/stderr 分行与 `writeLineAsync` 背压；`adapters/acp/transport.ts` 把 stdout 行转成 SDK 的字节流，stderr 只进回调，不混入协议。
3. **客户端能力最小化**：initialize 只声明文本 prompt 所需基线，不声明 `fs.readTextFile` / `fs.writeTextFile` / `terminal`。Agent 的工具调用不能借客户端绕过沙箱读写宿主文件。
4. **权限默认拒绝**：`session/request_permission` 无 handler 时选择 `reject_*` 或 `cancelled`；只有调用方显式提供 handler 才能 allow。Agent 的工具调用不等于 HubAgent 授权（PRD §6.4.5）。
5. **不假设可选方法存在**：`session/close` 仅在 `agentCapabilities.sessionCapabilities.close` 声明时调用；`session/resume` 只提供能力判断，M4 不调用。
6. **协议错误归因 `ADAPTER_INCOMPATIBLE`**：超时、版本不匹配、解析失败不进入 Agent 可靠性统计。

## 3. 后果

### 正面

- 协议 schema、请求关联、错误响应由官方 SDK 维护，减少自研分帧的静默错误。
- 与 ACP 生态同步升级；类型可直接用于事件映射与测试。
- 客户端能力最小化，保持"sandbox 是唯一执行边界"。

### 负面（已接受）

- SDK 处于快速演进期（2.x），升级需要回归；缓解 = 精确锁版本 + 本层隔离。
- 不提供 `fs/*` 意味着**依赖客户端文件读写**的 Agent 不受支持；标准 Coding Agent 通常自带文件工具，M4 的 mock 与真实 harness 探针都按这一边界验证。若未来出现必须依赖客户端 fs 的 harness，需要重新评估（见复审条件）。
- SDK 的 `ndJsonStream` 仍需要我们把 stdio 桥接正确；靠 `acp-client.test.ts` 的拆行/粘包/背压用例守住。

## 4. 被否方案

| 方案 | 否决原因 |
|---|---|
| 自研完整 JSON-RPC 层 | 能用，但 schema 与错误语义要跟着 ACP 演进；官方 SDK 已覆盖，重复造轮子只会增加漂移 |
| 为每个 harness 写兼容分支 | PRD §18.9 明确禁止；能力差异只能通过 ACP capability 协商 |
| 向 Agent 暴露宿主 fs，换取"少一次工具调用" | 等于把沙箱边界打开；客户端进程在沙箱外，Agent 可借此读写任意文件 |
| 权限默认 allow | 无人值守时等于自动授权；与 ADR 0002 的 fail-closed 冲突 |

## 5. 复审触发条件

1. `@agentclientprotocol/sdk` 发布不兼容 v1 的版本；
2. 真实 harness 在 M4 探针中必须依赖客户端 `fs/*` 才能完成典型任务；
3. ACP v2 稳定并要求切换；
4. SDK 的 `ndJsonStream` 在高吞吐下出现背压/内存问题。
