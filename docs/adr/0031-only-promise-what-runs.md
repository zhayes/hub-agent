# ADR 0031：编排器只承诺能执行的事——不做成本预算，不做 auto-merge

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-28
- **相关：** ADR 0009（交付默认 branch-only）、ADR 0029 §2.4（Web 接管 CLI 能力的硬门禁）、`docs/PRD.md` §6.12.4 / §6.13 / §13.5.2 / TC-017、`docs/PLAN-CONSOLE-INTERACTION.md` §3.8.14
- **证据：** `packages/hub/src/domain/schema.ts`、`packages/hub/src/domain/entities.ts`、`packages/hub/src/runtime/chat/run-settings.ts`、`packages/hub/src/runtime/workspace/deliver.ts`、`packages/hub/src/runtime/workspace/session.ts`

---

## 1. 背景

P8 的门禁要求「Web 在关掉 CLI 之前接管五项能力」，其中两项是**交付策略**与**预算上限**。审计实现时发现，这两项都存在「契约里写着、运行时执行不了」的问题：

1. **成本上限无法执行。** `delegate_task.budget` 的 schema 收 `maxTokens` / `maxCostUsd`，但整个 `packages/hub/src` 里没有任何调用量或费用计量：唯一的 token 数是 Brain 自己 prompt 的估算（`estimateInputTokens`、`JSON.stringify(actions).length / 4`），派给 Agent 的执行只传了 `maxWallClockMs`。也就是说这两个字段从来没有被读过一次。
2. **auto-merge 永远不生效。** 它的五个前置条件里有两个依赖项目级 `targetRef` / `autoMerge`，而项目记录里没有这两个字段，因此 `deliverTask` 只能一律拒绝。同时它还被写了一套降级规则、同项目串行排队与"合并后检查失败再升级"的流程——一个永远不会被执行的路径。
3. **产品定位与人确认冲突。** HubAgent 是协调者：活由别的 Agent 干，产出来汇总到控制台，**最终由人判断该不该进主干**。把"是否合并"与"花到多少钱就停"交给编排器，恰好是把它不该承担的风险接了过来。

「看起来有、其实没有」比缺失更糟：一个进过契约的成本上限字段，会让后来读代码的人以为费用有保险。

## 2. 决策

**只承诺能执行的东西。**

1. **不做成本预算。** 不引入计量层；`delegate_task.budget` 只保留 `maxWallClockMs`（它是真能执行的超时），删除 `maxTokens` / `maxCostUsd`。控制台的会话运行设置只留**验收命令**与**可用 Agent**，移除"预算"面板。
2. **保留内部护栏，但不做成配置项。** Brain 单回合的动作数、输入/输出 token 估算上限、回合超时仍是常量（`DEFAULT_BRAIN_BUDGET`）；委派保留墙钟超时。它们的作用是**不让守护进程挂死**，不是费用控制。
3. **交付只有两种模式**：`branch-only`（默认，分支留在原处）与 `patch-export`（写到 `~/.hubagent/artifacts/<taskId>.patch`）。**删除 `auto-merge`** 及其前置条件引擎，也删掉随之变成死代码的 `diffPatch`。
4. **不建交付记录表。** 交付结果随 HTTP 响应返回（`mode / branch / commitSha / patchRef`），补丁路径由 `taskId` 确定性推回；任务完成与否由 `completeTaskAfterDelivery` 表达。再建一张"交付表"是对现有事实的重复存储。
5. **P8 门禁收窄为四项**：并行扇出、验收命令、交付（两种模式）、后台执行。预算移出门禁——它不再是"Web 欠 CLI 的能力"，而是产品不做。

## 3. 被否方案

| 方案 | 否决原因 |
|---|---|
| A. 先做计量（provider usage 上报 + 价格表），再补 `maxTokens` / `maxCostUsd` | 需要每个 provider 上报可比的用量、维护价格表并回填历史；跨 provider 的"金额"本质上不可比。V1 的成本远大于收益，而且它解决的不是用户在这次对话里遇到的问题 |
| B. 字段留着，标成 experimental | 字段一旦进契约就会被依赖。空承诺比没有更坏——它让人误以为有止损 |
| C. 保留 auto-merge 但默认关闭（原方案） | 五个前置条件里两个依赖不存在的项目字段，等于把一条永不生效的路径写进规格；而且它绕过了"人确认"这个产品前提 |
| D. 另建 `delivery` 表记录每次交付 | 与确定性路径（`artifacts/<taskId>.patch`）重复；真正要回答的"这次运行完成了没有"已经由 Task 状态 + `completeTaskAfterDelivery` 回答 |
| E. 把预算做成"提示性建议"（只展示估算，不强制） | 估算口径是字符数/4，误差大到不能作为决策依据；展示一个不准确的数字比不展示更误导 |

## 4. 后果

- **契约变窄**：`budget` 只剩 `maxWallClockMs`。旧数据里多出来的 `maxTokens` / `maxCostUsd` 不会被读取，也不会报错。
- **设置面板变短**：会话运行设置从三项变两项。
- **`ha run` 的门禁理由消失**：ADR 0029 §2.4 的五项里，四项已可用；第五项（预算）已明确不做，因此门禁不再阻塞。CLI 创建任务是否关闭，属于另一个动作（见 §5）。
- **成本可见性缺失**：V1 控制台不显示 token/费用。要看用量只能去各 provider 自己的后台。这是有意识的取舍，不是遗漏。
- **删除的代码**：`runtime/workspace/delivery.ts`（前置条件 + 未使用的两种模式）、`git.ts` 的 `diffPatch`、`brainBudget()` 映射、`ChatRunSettings.budget`、两个预算 i18n 键。

## 5. 遗留

- ADR 0029 §2.4 的"CLI 拒绝"至今没有真正实施：`ha run` 没有 `--allow-task-create` 开关，也没有在缺失时拒绝。本轮**不**顺手改 CLI 行为——关闭一个还在被回归用的入口需要单独一轮（涉及 fixtures 与 `tests/e2e` 的跑法）。
- 门禁关闭只表示"不再缺能力"，不表示"入口已下线"。

## 6. 复审触发条件

- 某个 provider 开始稳定上报可比用量，且用户明确要求"按成本止损"时：重新评估计量与上限（此时 `maxCostUsd` 才有执行的可能）。
- 出现真正需要无人值守合并的产品场景（例如带自动分流的 CI 流水线）：重新评估 auto-merge，且必须先落项目级 `targetRef` / `autoMerge` 字段与冲突升级路径。
- 若用户反馈"跑一次太贵却没有任何提示"：优先做**单次运行的估算展示**（明确标注估算），而不是恢复强制上限。
