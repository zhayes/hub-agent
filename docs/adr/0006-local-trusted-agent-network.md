# ADR 0006：本地受信 Agent 默认采用 agent-managed 网络

- **状态：** 已接受（Accepted）
- **日期：** 2026-11-24
- **部分取代：** ADR 0002 中“所有 Agent 默认网络 allowlist/deny”的默认条款；文件与凭据边界条款继续有效
- **相关：** PRD §6.9.7；ARCHITECTURE §12.1；PLAN M4 / P0
- **证据：** `srt` 0.0.83 在省略 `network.allowedDomains` 时不做网络隔离；`poc/tc-014` 文件边界仍通过

---

## 1. 背景

ADR 0002 把网络也纳入默认强制边界：所有子进程默认 deny，按项目/契约 allowlist。这个决策对“远程/不可信 Agent”是对的，但对本地 Coding Agent 的产品体验不成立：

- 每个 Agent 都有自己的模型地址、工具链、文档查询、包管理器域名；
- 让操作者在每次 `run` 手传 `--allow-domain`，等于让 HubAgent 变成网络防火墙，而不是协调器；
- 真实任务会不断遇到“少一个域名”的假失败。

## 2. 决策

1. **本地受信 Agent 默认 `agent-managed`**：HubAgent 不安装网络白名单/代理，模型 API 与外部查询由 Agent 自己的配置负责。
2. **文件与凭据边界继续强制**：cwd/worktree、`allowedWrite`、`denyWrite`、`DEFAULT_DENY_READ` 不变；Agent 仍不能写工作区外、不能读凭据目录。
3. **策略按信任等级分层**：
   - `agent-managed`：本地受信 harness（DSH / Codex / Claude Code 等）；
   - `allowlist`：高风险、无人值守、需要审计的任务；
   - `deny`：远程 A2A / 不可信 Agent。
4. **策略归属**：Agent 注册时声明 `networkMode` / `allowedDomains` / `allowedWrite`；项目与任务契约可进一步收紧。`run` 的 `--allow-domain` 只保留为 allowlist 的一次性 override，默认路径不需要它。
5. **远程 Agent 不继承本地网络权限**（PRD §6.9.4 继续有效）。

## 3. 后果

### 正面

- 本地 Agent 的模型/工具网络开箱即用，不再需要逐次配置域名。
- HubAgent 的职责回到“协调、契约、证据、判定”，沙箱只负责它真正该管的文件/凭据边界。
- 高风险/远程仍可显式收紧，不需要删掉安全能力再重建。

### 负面（已接受）

- **开放网络意味着 prompt injection 可以把工作区内容发到任意地址**。这 accepted 的前提是“本地 Agent 是用户安装并信任的工具”。
- 网络不再提供“少一个域名就失败”的早期信号；高风险任务需要用户主动选 `allowlist`。
- 远程 A2A 必须继续使用严格模式，不能复用本地默认。

## 4. 被否方案

| 方案 | 否决原因 |
|---|---|
| 保留所有 Agent 默认 allowlist | 体验不成立，真实任务持续假失败 |
| 直接删除网络限制代码 | 远程/高风险没有退路，V1.1 要返工；保留模式切换成本更低 |
| 让 Agent 运行时自行扩权 | 被注入的 Agent 可以自己开网，等于没有边界 |

## 5. 复审触发条件

1. V1.1 A2A/Relay 上线：远程 Agent 必须重新评估默认；
2. 本地 Agent 被证明普遍不可信，或出现真实外泄事件；
3. 需要满足企业审计，要求默认 allowlist；
4. srt 提供“按 Agent 身份/凭据”的网络策略，可在不牺牲体验的前提下收紧。
