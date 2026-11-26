# 真实 Pi Brain 配置

## 默认行为

`hubagent run` 默认使用 **Pi SDK Brain**（`@earendil-works/pi-coding-agent`）：

```bash
export HUBAGENT_BRAIN_MODE=pi          # 默认；可省略
# 可选：Pi 全局配置目录，默认 ~/.pi/agent
export HUBAGENT_PI_AGENT_DIR="$HOME/.pi/agent"
# 可选：Brain 的 session cwd；默认当前目录
export HUBAGENT_BRAIN_CWD="$PWD"
```

Pi 的模型/认证来自它自己的配置：

```bash
pi /login        # 或使用已有的 ~/.pi/agent/auth.json + models.json
# 也可直接用 Pi 支持的 provider 环境变量，例如 DeepSeek：
export DEEPSEEK_API_KEY=...
```

没有配置 Pi 模型时，`run` 会 fail-closed，不会静默退回 ScriptedBrain。

离线/测试显式：

```bash
export HUBAGENT_BRAIN_MODE=scripted
```

`--brain-mode pi|scripted` 可在单次 `run` 覆盖；`--no-brain` 仍是 M4 固定脚本排障路径。

## 真实 Pi smoke

```bash
pnpm test:brain-real
```

它会用 Pi SDK 创建一个无工具 in-memory session，构造最小快照，输出 actions/validation/rationales。需要先完成 Pi 登录/模型配置。

## 实现边界

- `PiBrain` 只实现 `OrchestratorBrain.step/explain`；模型输出仍由 Runtime 做 schema/权限/预算/幂等校验。
- Pi session 只注册元工具（`customTools`）+ `DefaultResourceLoader(noExtensions/noSkills/noPromptTemplates/noContextFiles)`；Brain 不拿文件、shell、数据库句柄。
- `runGoalWithBrain` 用 dispatch 回合：plan → delegate → 执行 → 下一回合；同一 worktree，不并行。
- Pi session 注册 `reply` / `discover_agents` / `get_agent_detail` / `get_task_result` / `await_any` / `revise_plan` / `delegate_task` / `cancel_task` / `request_human` 元工具；工具只读快照或记录 intent，Runtime 校验后执行 `reply / revise_plan / delegate / cancel / request_human`。
- 不再维护手写 OpenAI-compatible client；模型配置/认证/provider 由 Pi 负责。

## 对话路径（Chat）

控制台的每一条用户消息都是一次 Brain 回合，快照里带最近若干轮 `conversation`（只含用户文本、助手回复和澄清问题；task/approval 卡片与旧错误不进上下文）：

- `reply` 或 `finish`：直接回给用户，不建 Task（`stopReason = replied`，Goal 直接 completed）；
- `request_human`：还没计划也可以先澄清，Runtime 落 Clarification 并把 thread 停在 `waiting`，UI 渲染成可点选项；
- `revise_plan`：才建 Task 并进入 dispatch 回合；
- 模型回的是自然语言而不是 JSON 时，按 `reply` 处理，不把整轮对话判成 `BRAIN_UNAVAILABLE`。

CLI 走同一条 Runtime，只是没有 `conversation`，因此 `hubagent run` 仍以「拆计划 → 执行 → 验收」为主；只回复的回合会把文本打到 stdout。
