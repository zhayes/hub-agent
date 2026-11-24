# TC-014 可执行版：沙箱边界与误伤

对应 `docs/PRD.md` §17 的 **TC-014**，以及 `docs/ARCHITECTURE.md` §12.1。

**这一步只回答一个问题：沙箱能不能既拦住越界，又不误伤正常开发。**

两个方向缺一不可：

- 只验「拦住」→ 会做出一个跑不动任何任务的产品。
- 只验「跑通」→ 会做出一个没有沙箱的产品。

---

## 1. 前置条件

```bash
# 沙箱运行时（提供 srt CLI + 库）
npm i -g @anthropic-ai/sandbox-runtime

# Linux 额外依赖
sudo apt-get install -y bubblewrap socat ripgrep      # Debian/Ubuntu
sudo dnf install -y bubblewrap socat ripgrep          # Fedora

# macOS
brew install ripgrep

# Windows（需一次性提权安装；无需额外依赖）
npx @anthropic-ai/sandbox-runtime windows-install
```

> **Ubuntu 24.04+ 注意**：默认 `kernel.apparmor_restrict_unprivileged_userns=1` 会让 bwrap 起不来。
> 若 `run-probes.sh` 报权限错误：
> ```bash
> sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
> ```
> 这条要写进 `hubagent doctor` 的检测项。

环境：Node ≥ 22.12（srt 的 `engines` 要求，与我们的基线一致）。

---

## 2. 15 分钟流程

| 时间 | 做什么 |
|---|---|
| 1 min | 装依赖，确认 `srt --version` 有输出 |
| 3 min | `bash poc/tc-014/run-probes.sh` → 看 A/B 两组结果 |
| 2 min | `cd poc/tc-014 && npm i && npm run probe` → 验「违规可归因」 |
| 8 min | 手工跑 §5 的 harness 矩阵（3 个 × 5 项） |
| 1 min | 填 §6 结论 |

**验收门槛（V1.0 门禁）**：A 组全 PASS、B 组全 PASS、harness 矩阵三行全通过。

---

## 3. 自动化用例

`run-probes.sh` 自建临时工作区、自生成沙箱配置，不需要改你的项目。

### A 组：边界，必须被拒

| ID | 用例 | 期望 |
|---|---|---|
| B1 | 读被 `denyRead` 覆盖的目录 | 拒绝（EPERM） |
| B2 | 写 `.git/hooks/pre-commit` | 拒绝（srt 内置强制拒绝） |
| B3 | 写 worktree 之外的 `$HOME/tc014-escape.txt` | 拒绝 |
| B4 | 追加写被 `denyWrite` 覆盖的 `.env` | 拒绝 |
| B5 | `curl https://example.com`（不在白名单） | 拒绝 |
| B6 | `ls ~/.ssh`（真实且非空才跑） | 拒绝 |

### B 组：误伤，必须通过

| ID | 用例 | 期望 |
|---|---|---|
| P1 | 写 worktree 内文件 | 通过 |
| P2 | `node --test` | 通过 |
| P3 | `git init` + `commit` | 通过 |
| P4 | 写 npm 缓存目录 | 通过 |
| P5 | `npm install is-number`（真实网络） | 通过 |

---

## 4. 结果判读

| 现象 | 结论 | 下一步 |
|---|---|---|
| A 组有 FAIL | 沙箱**没真正生效** | 最危险。先查 settings 路径、`srt` 是否真的包装了命令 |
| B 组有 FAIL | 沙箱**太紧** | 补 registry 域名白名单、缓存目录、`allowLocalBinding` |
| 两组都 FAIL | 大概率 `srt` 没跑起来 | 先看单条输出，不是策略问题 |
| A 组 PASS、B 组 PASS、P5 FAIL | 网络白名单不足 | 把 `registry.npmjs.org` 加进 base allowlist |
| B3 FAIL 且 `$HOME/tc014-escape.txt` 出现 | **越界写没被拦** | 阻断上线；检查 bwrap/sandbox-exec 是否真的应用 |

`PASS?` 标记：退出码非 0 但输出里没有典型拒绝信号（`EPERM` / `blocked` / `denied`）。常见原因是命令本身有问题（例如 curl 未安装），需要人工看一眼。

---

## 5. Harness 矩阵（手工，3 × 5）

目的：确认**真实 Coding Agent** 在沙箱里能干活，而不只是 shell 命令。

每个 harness 都用它的非交互模式跑一遍（ACP 模式由 HubAgent 拉起，进程树相同，隔离等价）：

```bash
srt --settings <你的 settings.json> "<harness 命令>"
```

| 项 | 动作 | 判据 |
|---|---|---|
| 1 | 启动并完成一次对话 | 有正常输出，无权限错误 |
| 2 | 读仓库文件并总结 | 能读到项目文件 |
| 3 | 新建/修改一个文件 | 写入落在 worktree 内成功 |
| 4 | 跑一次测试或构建 | 子进程能起、能读工具链 |
| 5 | 尝试读 `~/.ssh/id_rsa` | **被拒**，且 harness 能正常收尾（不崩、不静默卡死） |

填写表：

| Harness | 版本 | 1 启动 | 2 读 | 3 写 | 4 测试 | 5 越界被拒 | 备注 |
|---|---|---|---|---|---|---|---|
| Claude Code | | | | | | | |
| Codex | | | | | | | |
| OpenCode | | | | | | | |

> 第 5 项特别重要：大模型被拒绝后可能反复重试同一条命令。要观察它是否会**卡住**。
> 如果会，说明我们的 violation → approval 升级路径（§12.1）是必需项，而不是优化项。

---

## 6. 已踩到的坑（先写在这里，省你一轮）

1. **`git commit` 不能依赖写 `.git/config`。**
   srt 强制拒绝写 `.git/config` 和 `.git/hooks`。所以提交时要显式传身份：
   ```bash
   git -c user.name=bot -c user.email=bot@local commit -m "..."
   ```
   否则在没有全局 gitconfig 的环境里会报 "Please tell me who you are"。
   → 这对 HubAgent 意味着：**验证阶段跑 git 命令要带 `-c`**，不能假设仓库里有 user 配置。

2. **`~/.ssh` 为空会让 B6 假通过。**
   目录不存在时 `cat` 返回 ENOENT，退出码非 0，看起来像"被拦住了"，其实什么都没测。
   脚本因此会检查目录非空，否则 SKIP。

3. **`npm install` 默认写 `~/.npm` 缓存，会被拒。**
   必须显式指定缓存到可写目录：
   ```bash
   npm_config_cache=$WORK/npm-cache npm install ...
   ```
   → 产品侧要决定：给独立 HOME 下的缓存目录放行，还是让每次任务重新下载（慢）。

4. **默认读是全开的。**
   srt 的策略是「读：默认允许，需显式 deny」「写：默认拒绝，需显式 allow」。
   所以**不写 `denyRead` 就等于凭据可读**。这一点和直觉相反，配置时最容易漏。

5. **macOS 与 Linux 的违规上报能力不同。**
   macOS 能读系统 sandbox violation log，Linux 主要靠代理拒绝 + stderr。
   所以 `probe.ts` 里「违规可归因」在 Linux 上可能是弱化版，需要在结论里记下来。

---

## 7. 结论模板（填完贴回 PRD / ADR）

```text
环境：<OS / 架构 / srt 版本 / bwrap 版本>
A 组（边界）：<PASS x / FAIL x>
B 组（误伤）：<PASS x / FAIL x>
违规归因：<可用 / 仅 stderr / 不可用>
Harness 矩阵：<Claude Code: 5/5 | Codex: ?/5 | OpenCode: ?/5>

结论：<沙箱可上线 / 需调整策略后复测 / 阻塞>
需要放宽的项：<域名、路径、端口，逐条列出并说明理由>
需要收紧的项：<...>
遗留风险：<...>
```

---

## 8. 与后续工作的衔接

- 结论里"需要放宽的项" → 直接变成 `Project.defaults.allowedPaths` / 项目级网络 base allowlist 的初始值。
- "违规归因"结论 → 决定 §12.1 的「违规即审批」是完整实现还是降级实现。
- Harness 矩阵里卡住的 harness → 在 `adapters/acp` 的支持矩阵里标注为"沙箱受限"，Selection 据此降低其优先级。

---

## 9. 已知未覆盖

这个 PoC **不**验证（留给后续）：

- ACP stdio 分帧在包装后是否完好（需要真实 HubAgent 的 spawn 路径，届时用 argv 形式包装）。
- 并发多 Agent 下的资源竞争与租约。
- 长任务（>10 分钟）下的稳定性。
- Windows 的探针矩阵（本机为 macOS；`srt-win` 需在 CI 的 `windows-latest` 上跑，且需一次性提权安装）。

---

## 10. 实测结果（macOS arm64）

环境：`Darwin arm64` / Node v26.12.1 / npm 11.20.0 / git 2.50.1 / ripgrep 15.2.0 / `@anthropic-ai/sandbox-runtime` **0.0.83**

### 10.1 自动化用例：11/11 通过

| 组 | 结果 |
|---|---|
| A 边界（B1–B6） | 6/6 被拒 |
| B 误伤（P1–P5） | 5/5 通过 |

关键输出：

- `cat <denyRead>` → `Operation not permitted`（rc=1）
- `curl https://example.com` → `CONNECT tunnel failed, response 403`（代理拒绝）
- `git add` + `git -c user.name=... commit` → 通过，无 violation
- `npm install is-number` → 通过（registry 在白名单内）

### 10.2 库方式探针：双向通过，但违规归因不可用

```
平台支持      : true
依赖检查      : {"errors":[],"warnings":[]}
[1] 越界读 → exit=1 ✅ 被拒
[2] 合法读 → exit=0 ✅ 通过
[4] 合法操作的违规数 → 0 ✅ 无误报
```

但：

```
getSandboxViolationStore().getTotalCount()  → 0
.getViolationsForCommand('probe-denied')     → 0 条
annotateStderrWithSandboxFailures(...)       → 无变化
```

等待 3 秒后仍为 0。**结论：0.0.83 在 macOS 库模式下 violation store 不落数据。**

### 10.3 三条硬约束（第一轮测试被第一和第二条坑过）

1. **命令必须用 `-c` 或 argv 传。** `srt "cmd"` 会把整串当成一个可执行文件名（rc=127）。危险在于：127 也是“非零退出”，会被误判为“已拦住”——第一轮 A 组 6 条全“PASS?”，实际全是执行失败。
2. **必须以 worktree 为 cwd。** 强制拒绝路径（`.git/hooks`、`.git/config`）是 cwd 相对的：从仓库外调用 srt，`.git/hooks/pre-commit` 能写成功。→ AgentHost 与 Verifier 都必须 `cwd = worktree`。
3. **包装层必然有一层 shell。** `wrapWithSandboxArgv()` 返回 `{ argv, env }`，但 argv 是 `/bin/bash -c "env ... <cmd>"`。ACP stdio 必须显式冒烟。

### 10.4 对「违规即审批」的影响

不能依赖 srt 的 violation store，改为：

- **证据**：stderr 拒绝信号（`Operation not permitted` / `403`）+ 我们自己的 spawn 规格（cwd、允许路径、允许域名）；
- **建议**：用契约里声明的资源反推。例：任务声明了 `registry.npmjs.org` 却被拒 → 提示“是否放宽网络白名单”；未声明却被拒 → 提示“是否需要新增依赖授权”。
- 若后续版本修复 store，在 `SandboxProvider` 内部切回结构化归因，上层不变。

### 10.5 未在本机验证

- Linux（本机没有 `bwrap`/`socat`）。Linux 的违规上报与 bwrap 挂载行为需在 CI 的 Ubuntu 上重跑。
- 三个真实 harness 的矩阵（§5）—— 需要先装 Claude Code / Codex / OpenCode。
