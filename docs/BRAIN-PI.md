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
- Pi session 使用 `noTools: "all"` + `DefaultResourceLoader(noExtensions/noSkills/noContextFiles)`；Brain 不拿文件、shell、数据库句柄。
- `runGoalWithBrain` 会按 `revise_plan` 顺序执行全部子任务；同一 worktree，不并行。
- 不再维护手写 OpenAI-compatible client；模型配置/认证/provider 由 Pi 负责。
