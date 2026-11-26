# ADR 0028：A2A 协议层采用官方 `@a2a-js/sdk`

状态：Accepted（2026-11-26）

## 背景

A2 阶段要同时提供 A2A Server 与 Client。协议本身在 1.0 有大量必须做对的细节：`A2A-Version` 校验（空头按 0.3 处理）、错误码 `-32001..-32009` 的映射、`SubscribeToTask` 的重订阅语义（必须先挂事件总线再读任务，否则漏事件）、`INPUT_REQUIRED`/`AUTH_REQUIRED` 的可续语义、`Content-Type: application/a2a+json`、`StreamResponse` 的 oneof 判别。

自己写这些等于长期维护一份规范副本；而用自己写的实现对自写测试验证，属于"验收自证"，与本仓库 ADR 0007 的底线冲突。

## 决定

**采用官方 SDK `@a2a-js/sdk` 作为协议层，只剥语义、不外包语义。**

- 依赖：`@a2a-js/sdk`，**精确锁定版本**（当前 1.3.0），不用 `^`。它唯一的运行时依赖是 `jose`；`express` / `better-sqlite3` / `@bufbuild/protobuf` / `@grpc/grpc-js` 等 peer 依赖全部 optional。
- 分层：
  - `interfaces/a2a`（组合根）：构造 SDK 的 `DefaultRequestHandler`，注入下面的实现，挂 SDK 的 Express transport 到**独立端口**（ADR 0026 的独立监听面）。
  - `adapters/a2a`：只依赖 SDK 类型；负责 proto 风格类型（`{ $case }`）与本地模型之间的映射，**不 import runtime**（守住 R4）。
  - `runtime/a2a-executor.ts`：实现 SDK 的 `AgentExecutor`（`execute` / `cancelTask`），内部调 Runtime 应用服务。
  - `TaskStore`：自己用 better-sqlite3 实现三个方法（`save` / `load` / `list`）。**不使用** SDK 的 Kysely/SQLite store——否则 A2A 任务表会和本地事件模型分裂成两套真相。
- Agent Card、版本校验、错误类型、取消与 push 配置路由交给 SDK；**验收、幂等、对账、状态机归属仍在 Runtime**。

## 常用请求的落点

| A2A 能力 | 由谁负责 |
|---|---|
| `SendMessage`（非阻塞） | SDK 路由 → `AgentExecutor.execute` → Runtime 建本地 Goal/Task，回 `SUBMITTED`/`WORKING` |
| `GetTask` / `ListTasks` | SDK → 我方 `TaskStore`（投影，不代替本地状态机） |
| `CancelTask` | SDK → `AgentExecutor.cancelTask` → Runtime `cancelTask` |
| `SubscribeToTask`（SSE） | SDK 维护总线与重订阅；我们通过 `ExecutionEventBus` 发布本地事件 |
| Agent Card | SDK 结构 + 我们的能力白名单投影（不含内部目录） |
| 版本 / 能力校验 | SDK（`validateVersion`、`UnsupportedOperationError`） |

## 被否方案

- **手写 JSON-RPC + SSE 编解码**：规范细节多且会变（1.0 已移除 `kind` 判别符），维护成本高于依赖成本；且测试只能自证。
- **仅用 HTTP+JSON/REST 手写、绕开 JSON-RPC**：binding 与 PLAN-A2A §4.4 锁定的 `JSONRPC` 不一致，跨实现互操作性反而更差。
- **引入完整第三方 agent 框架（LangGraph 一类）**：会把编排语义也外包出去，直接违反"Brain 不写文件、Runtime 拥有状态"的分层。
- **直接用 SDK 的 Kysely store**：多一层查询构建器，且任务表与我们的事件/投影分离，对账时容易出现两个真相源。

## 后果

- 新增运行时依赖 `@a2a-js/sdk`（+ `jose`）。这是协议级依赖，升级要按 ADR 走，不做静默 minor 升级。
- **A2A 端口会跑 Express**，与主服务的 Hono 并存。这是有意的隔离（独立监听面 + 独立鉴权），不是漏改；若将来要统一，先改本 ADR。
- 需要一层 proto 风格 ↔ 本地模型的映射 adapter，工作量已计入 A2。
- SDK 版本的 `TaskState` / `AgentEvent` 形状由它决定；PRD §7.6 的映射表以**锁定版本**为准，SDK 大版本升级必须先复核该表。

## 验证方式

- **导入冒烟**：`@a2a-js/sdk/server` 与 `/client` 在本仓库 tsconfig（strict）下能解析并通过 typecheck。
- **版本与错误**：不支持的 `A2A-Version` 返回 `VersionNotSupportedError`；未声明能力返回 `UnsupportedOperationError`（用 SDK 自带类型断言，不自定义错误字符串）。
- **重订阅**：断线后 `SubscribeToTask` 首帧是当前 Task 快照，终态返回 `UnsupportedOperationError`。
- **互操作**：两个本地 HubAgent 通过 SDK Server/Client 完成一次真实委托（A5 场景 1 的前置）。

## 复审 / 变更（2026-11-26，同日）

**变更：不使用 `@a2a-js/sdk/server/express`，改用 transport-agnostic 的 `JsonRpcTransportHandler` 挂到现有 Hono。**

原因：核实后发现 `JsonRpcTransportHandler.handle(body, context)` 返回 `JSONRPCResponse | AsyncGenerator<JSONRPCResponse>`，已经与 HTTP 框架解耦；`/server/express` 只是它的一层薄包，且需要额外装 `express`。既然本仓库已用 Hono，再引入第二套 web 框架没有收益。原决定中“A2A 端口独立监听”不变，变的只是谁来挂路由。

- 不动协议层选型：仍在用官方 SDK 的 proto 类型、版本校验、错误码、`DefaultRequestHandler`。
- `express` 不进入依赖树；A2A 计算端口由 `interfaces/a2a` 用 Hono 挂 `JsonRpcTransportHandler`（JSON-RPC 与 SSE）。
- 上文“后果”里“A2A 端口会跑 Express”作废，其余不变。

**实测踩到的坑（必须记住）：** `JsonRpcTransportHandler.handle` **自己不校验版本**（0.3 / 0.5 / 2.0 都会放过），`validateVersion` 要调用方自己调。所以 `interfaces/a2a` 在 `handle` 之前显式调用 `validateVersion(header ?? '0.3', card, 'JSONRPC')`，否则 PRD §7.6.5 的“拒绝未声明版本”就是空话。另一个坑：`TaskStatus.state` 序列化成字符串（`"TASK_STATE_COMPLETED"`），断言要用 `taskStateToJSON`，不能拿数值枚举比。

## 复审触发条件

- `@a2a-js/sdk` 出现 major 升级，或 `TaskState` / `AgentEvent` 形状变化；
- Express 与主服务依赖出现版本冲突，或需要把 A2A 并入 Hono；
- A2A 规范发布 1.1+ 且引入与 PRD §7.6 映射冲突的状态。
