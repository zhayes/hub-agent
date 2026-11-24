# ADR 0009：工作区租约互斥，交付默认 branch-only

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **相关：** PRD §6.12.2–§6.12.4；ARCHITECTURE §6.6；PLAN M7
- **证据：** `lease.test.ts`、`merge.test.ts`、`delivery.test.ts`

---

## 1. 背景

多个 Coding Agent 同时改同一仓库是常态。没有租约与交付边界，会出现：

- 两个执行写同一个 worktree，互相覆盖；
- 验收通过后直接进主干，把仓库级风险交给一次任务；
- 合并冲突被静默覆盖，无法回滚。

## 2. 决策

1. **租约入库**：`workspace_leases` 记录 `mode/path/branch/baseRef/holder/expiresAt`；`active` 租约按路径重叠互斥。
2. **不同 worktree 可并行**：只有路径重叠才冲突；两个 `shared` 只读可共享，写入租约与任何重叠租约冲突。
3. **过期 sweep**：`expires_at` 到期先置 `expired`，崩溃恢复可重新判定 `abandoned`。
4. **git 命令经 `GitRunner`**：生产实现 `AgentHostGitRunner` 走 AgentHost/SandboxProvider，Runtime 不直接 `child_process`。
5. **交付模式**：
   - 默认 `branch-only`（保留分支，不合并、不 push、不开 PR）；
   - `patch-export` 导出 diff 到 artifact；
   - `auto-merge` 必须同时满足五个前置条件，缺一即降级 `branch-only` 并记录原因。
6. **合并不静默覆盖**：`merge --no-ff` 冲突即 `DELIVERY_CONFLICT`，升级 Brain/用户决策；保留 baseline ref，可 `reset --hard` 回滚。
7. **V1.0 不 push**：远程推送需要独立授权，不在本里程碑。

## 3. 后果

### 正面

- 并行任务有可验证的互斥边界；不同 worktree 不互相阻塞。
- 交付默认保守，验收通过不会自动改主干。
- 合并冲突、回滚、降级都有确定规则与测试。

### 负面（已接受）

- worktree 数量与磁盘占用增长；失败/取消现场默认保留，需要 `task clean`。
- task 完成必须等交付动作落地，验收 pass 只是前置条件（PRD §6.12.4）。
- `auto-merge` 在 V1.0 默认关闭，用户需要显式配置。

## 4. 复审触发条件

1. M7 CLI 接线完成，`run --isolation worktree` 与 `task clean` 可用；
2. TC-002 双 Agent 并行需要更细的路径重叠规则（文件级 vs 目录级）；
3. 大仓库的 worktree 创建/回收性能不可接受；
4. V1.1 远程交付需要 push/PR 授权。
