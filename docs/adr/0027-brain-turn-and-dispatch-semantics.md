# ADR 0027：Brain 回合不阻塞，执行结束由 Runtime 派发下一回合

状态：Accepted（2026-11-26）

## 背景

PRD 与代码在“Brain 怎么等执行结果”上是互相矛盾的：

- `PRD.md` §10.1 第 12 步写「Brain 通过 `await_any` 等待到决策点，而不是轮询」；§13.5.3 给出的签名是 `executionIds + wakeOn + timeoutMs` 的阻塞调用。
- 实现里 `await_any` 只读快照、立即返回（`brain/pi/meta-tools.ts`），而 `runGoalWithBrain` 又在单栈里 `await runAcpWithRetry`，实际是“入口同步阻塞”。

两种口径并存的结果是：谁都不能拿 PRD 当验收依据，接 A2A 时也无法回答“远端结果回来了谁继续调度”。

## 决定

**D1 — Brain 回合不阻塞。** `delegate_task` 只记录 intent 并立即返回；Brain 回合跑完就结束，不等待执行。

**D2 — `await_any` 保留但不阻塞。** 它是“读快照，返回已终态与待执行的 subtask”，不是等待原语。PRD §10.1 / §13.5.3 按此修订：删掉 `executionIds` / `wakeOn` 的阻塞语义，签名以实际实现为准。

**D3 — 结果落库与下一决策点同事务，由 Runtime 驱动下一回合。** 执行结束时 Runtime 在一次事务里写「执行结果事件/投影」+「下一决策点」；决策点被 claim 后触发下一个 Brain 回合。SSE/CLI 只是观察端，不承担唤醒职责。

**D4 — 派发意图先落库，再执行；Execution ID 确定性派生。** dispatch intent 在调用 ACP/A2A 之前写入 `dispatch_queue`；`executionId` 由 `idempotencyKey` 派生，重放命中已有 intent 时**不重复执行**，只对账并补收尾。

**D5 — 入口允许过渡态同步等待。** 现有 `runGoalWithBrain` / `runParallelAgents` 可以暂时继续 `await` 执行（保持现有用户可感知行为），但这是过渡实现：A1 阶段退出前必须改成“派发即返回 + 由决策点驱动”，并有崩溃点测试守住。

## 被否方案

- **在工具里真阻塞（PRD 原文）**：会长时间占住模型上下文与决策点租约（180s 不够），且 A2A 的分钟级任务必然超时；同时让“重启后续跑”无处落脚。
- **Brain 轮询 `get_task_result`**：PRD §13.5.1 已把它列为反模式，按轮次烧 token。
- **先引入 Restate/Hatchet 再谈语义**：把外部运行时当成语义缺失的补丁；本仓库的 SQLite 队列 + outbox + 对账足以覆盖 A1 门禁（见 `PLAN-A2A.md` §5.3 的决策门）。
- **让执行结果直接写“任务成功”**：违反“验收不得自证”（ADR 0007）。

## 后果

- `PRD.md` §10.1 第 12 步、§13.5.3 需同步修订（本次一并改）。
- 需要持久化 Dispatcher（`runtime/dispatch`）：从库里领意图、带 fencing、收尾与下一决策点同事务。
- 需要“决策派发循环”把 pending 决策点重新跑起来；在那之前，回收只是把行退回 pending，不等于自动恢复（已在 `PLAN-A2A.md` §5.1 标注）。
- 崩溃点门禁：kill daemon 于 claim / dispatch / 执行中 / 结果写入前后，不得重复执行同一 subtask。

## 复审触发条件

- 出现单条执行超过 dispatch 租约（30min）成为常态，需要续租或心跳；
- 决策点队列被证明无法支撑并发 Goal（再评估是否引入外部 durable execution）；
- 模型上下文成本证明“多回合读快照”比“单回合阻塞”更贵。
