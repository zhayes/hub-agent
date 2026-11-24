# 真实 LLM Brain 配置

## 默认行为

`hubagent run` 默认使用 OpenAI-compatible LLM Brain：

```bash
export HUBAGENT_BRAIN_MODE=llm          # 默认；可省略
export HUBAGENT_BRAIN_API_KEY=...
export HUBAGENT_BRAIN_BASE_URL=https://api.deepseek.com
export HUBAGENT_BRAIN_MODEL=deepseek-chat
```

没有 key 时 **fail-closed**，不会静默退回 ScriptedBrain。离线/测试显式：

```bash
export HUBAGENT_BRAIN_MODE=scripted
```

`--brain-mode llm|pi|scripted` 可在单次 `run` 覆盖；`--no-brain` 仍是 M4 固定脚本排障路径。

## 真实 key smoke

```bash
HUBAGENT_BRAIN_API_KEY=... pnpm test:brain-real
```

它会构造一个最小快照，调用真实模型，输出 actions/validation/rationales；无 key 时 SKIP。

## 当前边界

- 适配器是 OpenAI-compatible chat completions，不是 Pi SDK 集成。
- `runGoalWithBrain` 目前只执行 `revise_plan` 的第一个子任务；真实模型即使拆多个，也不会全部执行。
- 输出仍经过 `runtime/validate.ts` 的 schema/权限/预算/幂等校验，不因模型而放宽。
- 模型失败/超时归因 `BRAIN_UNAVAILABLE`，不会静默通过。
