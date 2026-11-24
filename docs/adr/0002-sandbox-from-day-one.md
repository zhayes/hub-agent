# ADR 0002：沙箱从 V1.0 起强制启用（fail-closed）

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-23
- **相关：** PRD §2.1 / §6.9.7 / §17 TC-014；ARCHITECTURE §2.1 / §3.1 R8 / §12.1
- **证据：** `poc/tc-014/`（可复跑）

---

## 1. 背景

HubAgent 把编码工作交给第三方 Coding Agent（Claude Code / Codex / OpenCode）执行。这带来一个结构性事实：

> **HubAgent 自己不执行敏感操作，但它是唯一能决定"这些操作在哪里执行"的角色。**

敏感动作全部发生在被 `spawn` 出来的子进程里：改文件、跑命令、装依赖、连网。而 HubAgent 的父进程身份决定了它无法拦截子进程的系统调用——`allowedPaths`、`cwd`、契约都只是**声明**；只有内核能把声明变成**强制**。

同时，产品形态本身要求"长任务、无人值守、后台跑"。在无人值守下，权限审批会退化为"自动批准"——此时若没有强制层，等于把用户凭据和全局环境直接交给一个由模型驱动的进程。

因此这里要回答的不是"要不要安全"，而是"**在没有强制层的情况下，我们是否敢让它在无人值守模式下跑**"。

---

## 2. 决策

1. **V1.0 起强制启用系统级沙箱**（macOS `sandbox-exec` / Linux `bubblewrap` / Windows `srt-win` + WFP），不设"先上线后补"的中间态。
2. **强制对象**：Coding Agent 进程与验证命令进程，二者处于同一等级隔离。
3. **唯一执行入口**：所有子进程必须经 `SandboxProvider` 启动。由 R8 架构规则保证 `agent-host/**`、`sandbox/**` 之外不出现 `node:child_process`。
4. **fail-closed**：沙箱依赖缺失或初始化失败时**拒绝执行**，不降级为无隔离运行。
5. **实现**：`@anthropic-ai/sandbox-runtime`（Apache-2.0）薄封装，隔离在 `SandboxProvider` 之后，不向上层泄漏其类型。
6. **证据与升级**：隔离导致的失败归因为 `sandbox_denied`，并生成可审批的放宽建议（仅本次生效），不表现为普通任务失败。
7. **不提供常规的"跳过沙箱"开关**。确需放宽时，只能由用户显式、按项目、带有效期授权，并记为高风险事件。

---

## 3. 实测依据（macOS arm64，srt 0.0.83，Node v26.12.1）

`poc/tc-014/run-probes.sh` 复跑结果：**PASS=11 FAIL=0 SKIP=0**

| 组 | 用例 | 结果 |
|---|---|---|
| A 边界 | 读 denyRead 目录 / 写 `.git/hooks` / 写 worktree 外 / 写 `.env` / 访问白名单外域名 / 读真实 `~/.ssh` | 6/6 被拒 |
| B 误伤 | 写工作区 / `node --test` / `git commit` / 写 npm cache / `npm install`（真实联网） | 5/5 通过 |

库探针（`poc/tc-014/probe.ts`）：双向验证通过（能拦、不误伤），但 **violation store 无数据**（`getTotalCount() === 0`，等 3 秒后仍为 0）。

### 3.1 三条由此产生的硬约束

| # | 约束 | 原因 |
|---|---|---|
| C1 | 命令必须以 `-c`（字符串）或 argv 传递 | `srt "cmd"` 会把整串当可执行文件名，返回 `rc=127`；该退出码极易被误判为"已拦截" |
| C2 | **必须以 worktree 为 cwd 启动** | 强制拒绝路径（`.git/hooks`、`.git/config`、`.bashrc`…）以进程 cwd 为基准；从仓库外调用时这层保护静默失效（实测可写入 `.git/hooks/pre-commit`） |
| C3 | ACP stdio 必须显式冒烟 | `wrapWithSandboxArgv()` 返回 `{ argv, env }`，但 argv 仍是 `/bin/bash -c "env … <cmd>"`，包装层必然引入一层 shell |

> C1 差点让第一次测试得出相反结论：A 组 6 条全部显示"非零退出"，看似全部被拦住，实际全部是执行失败。这也是 TC-014 判定改为"非零退出 **且** 出现拒绝信号（EPERM / 403）"的原因。

---

## 4. 后果

### 正面

- 凭据外泄（`~/.ssh`、`~/.aws`、`~/.kube`）、全局配置污染（`.zshrc`、`.git/config`）、供应链外联从"靠自觉"变成"内核拒绝"。
- 无人值守与后续远程委托（V1.1 A2A）有了安全前提，避免届时返工。
- 违反沙箱的行为可归因、可审批，成为产品能力（"可协商的边界"）而非黑盒报错。

### 负面（已接受）

- **依赖风险**：`@anthropic-ai/sandbox-runtime` 处于 0.0.x，API 与内部行为可能变动。缓解：`SandboxProvider` 隔离 + 保留自研 bwrap/Seatbelt 包装作为退路。
- **装得上才能用**：fail-closed 使依赖自检成为启动路径的一部分，`hubagent doctor` 不是可选功能。Linux 需要 `bwrap` / `socat` / `ripgrep`；Ubuntu 24.04+ 还需处理 `kernel.apparmor_restrict_unprivileged_userns`。
- **假失败**：隔离会让"少一个域名/路径"表现为任务失败，必须靠 violation → approval 化解释放，否则用户会认为产品坏了。
- **策略面积变大**：`DelegationContract` 需增加 `sandbox.network` / `sandbox.filesystem`，Selection 需把"隔离约束能否满足"纳入过滤。
- **包装层有 shell**：C3 带来 ACP stdio 的验证成本。

### 中性

- 性能影响在本地单用户场景可忽略，但大仓库在 Linux 上的 bind mount 数量受 bwrap 参数上限约束（约 3000 个挂载），需要在 `doctor` 中给出提示。

---

## 5. 备选方案与被否原因

| 方案 | 否决原因 |
|---|---|
| 延后到 V1.1 | 远程委托引入"陌生输入"后必然要补；届时 `spawn` 路径、契约、验收用例都要改，返工成本高于现在 |
| 只做 T1（独立 HOME / TMPDIR / env 清洗） | 能挡住凭据读取，但**不限制网络与路径**，最贵的 exfiltration 与越界写仍可发生。可作为无 srt 平台的降级形态，不能作为唯一机制 |
| 自研 bwrap / Seatbelt 封装 | V1 不做：profile 生成、代理桥接、违规上报三块细节成本高。通过 `SandboxProvider` 保留为退路 |
| 容器 / devcontainer 隔离 | macOS 走 VM、大仓库 I/O 明显变慢，且要求用户预装 Docker；不适合默认路径（可作为高风险任务的 T3 模式） |
| 依赖 harness 自带的权限提示 | 各家实现与判断标准不同；无人值守时必须关闭这些提示，一关就只剩外层防线 |
| fail-open（缺依赖时降级裸跑） | 使沙箱在真实世界里约等于不存在；与决策 1 直接冲突 |

---

## 6. 如何防止漂移

| 机制 | 位置 |
|---|---|
| `agent-host/**`、`sandbox/**` 之外禁止 `node:child_process` | ARCHITECTURE §3.1 **R8**（dependency-cruiser，CI 失败即阻断） |
| 启动前依赖自检，缺失即拒绝 | `hubagent doctor` + `SandboxManager.checkDependencies()` |
| 双向验收（拦得住 + 不误伤） | PRD §17 **TC-014**，`poc/tc-014/run-probes.sh` |
| 强制 cwd | AgentHost 与 Verifier 的 spawn 规格，Code Review 检查项 |
| ACP stdio 完整性 | spawn 后做一次 stdio 往返冒烟（RPC 请求/响应 + 信号） |

**复审触发条件**（任一出现即重新评估本决策）：

1. `sandbox-runtime` 发布 1.0（API 稳定后收紧封装厚度）；
2. violation store 在库模式下可用（切回结构化归因，"违规即审批"可加强）；
3. macOS 移除或破坏 `sandbox-exec`（需切自研或容器方案）；
4. 多个 harness 在沙箱内无法完成典型任务（说明隔离过紧，需调整默认策略而非放弃沙箱）。

---

## 7. 未验证项（明确留白，不做隐含假设）

| 项 | 状态 | 计划 |
|---|---|---|
| Linux（bwrap/socat、挂载行为、违规上报） | **未实测**（本机无 bwrap） | CI 的 Ubuntu 矩阵中跑 `run-probes.sh` |
| 三个真实 harness × 5 项动作 | **未实测** | 安装后按 PoC README §5 填表 |
| ACP stdio 在包装层下的分帧/信号 | **未实测** | 集成 `AgentHost` 时做往返冒烟 |
| 长任务（>10 分钟）稳定性与租约 | 未覆盖 | Phase 1 |
| Windows | **alpha**（srt 提供 `srt-win`：`srt-sandbox` 账户 + WFP 出网围栏 + 写受限令牌 + NTFS ACL；需一次性提权安装） | CI 的 `windows-latest` 跑探针；已知 Schannel 客户端不可用（PRD §6.9.8） |

---

## 8. 参考

- `docs/PRD.md` §6.9.7（产品决策）、§17 TC-014
- `docs/ARCHITECTURE.md` §12.1（强制层设计）、§3.1 R8
- `poc/tc-014/`（可执行验证：`run-probes.sh`、`probe.ts`、README §10 实测结果）
- `@anthropic-ai/sandbox-runtime` 0.0.83（Apache-2.0）
