# 用真实 Claude Code / DSH 跑回归基线

## 先说清楚两件事

1. **`fixtures/regression-tasks` 是 mock 基线**：它的 checks 绑定 `mock-output.txt`，换成真实 harness 会全部 fail。真实 harness 用 `fixtures/regression-tasks-real`（checks 针对真实文件/测试）。
2. **bench 目前只替换执行 Agent，不替换 Brain**：`runGoalWithBrain` 仍用 `ScriptedBrain`（单子任务）。所以 `brainDecisionsPerTask` / 过度拆解率不是 LLM Brain 指标；要测 Brain 本身，需要先接 Pi/LLM 适配器。

## Claude Code

Claude Code 的 `claude` 不是 ACP server；需要 Zed 的 ACP adapter：

```bash
npm install -g @zed-industries/claude-code-acp
claude   # 先完成登录/配置；adapter 复用 ~/.claude
```

跑真实 suite：

```bash
pnpm bench \
  --suite fixtures/regression-tasks-real \
  --out reports/real-claude.json \
  --agent-command 'claude-code-acp' \
  --agent-allow-write "$HOME/.claude" \
  --agent-allow-write "$HOME/.claude.json"
```

`--agent-allow-write` 只放行 harness 自己的状态目录；worktree 本身已自动可写。不要把项目外的源码目录加进来。

## DeepSeek Harness（DSH）

DSH 用 ACP profile：

```bash
export DSH_ACP='ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile acp'

pnpm bench \
  --suite fixtures/regression-tasks-real \
  --out reports/real-dsh.json \
  --agent-command "$DSH_ACP" \
  --agent-allow-write "$HOME/.dsh" \
  --agent-allow-write "$HOME/Library/Application Support/DeepSeek Harness" \
  --agent-allow-write "$HOME/Library/Caches/DeepSeek Harness"
```

DSH 自己会读写 `$DSH_HOME`（默认 `~/.dsh`）和 macOS 应用缓存；如果它还报别的路径，按错误提示补 `--agent-allow-write`，不要一次放行整个 `$HOME`。

## 建议顺序

1. 先只跑 `fixtures/regression-tasks-real` 的 3 条，确认 adapter、登录、沙箱写路径都通。
2. 再把 3 条扩展成 20–30 条：每条用 `files` 预置一个小仓库，`checks` 写可执行验收，`diffScope` 收紧修改范围。
3. 对比 `reports/mock-baseline.json` 与 `reports/real-*.json`：
   - `autonomousCompletionRate`：真实任务完成率；
   - `verificationMisjudgmentRate`：负例是否被漏判；
   - `humanInterventionsPerTask`：审批/人工介入；
   - `averageDurationMs`、失败记录里的 `error`。
4. 保存 JSON，不要只截图；报告里的 `records` 能回溯每条任务的 verdict 和错误。

## 常见坑

- **直接跑旧 suite**：checks 找 `mock-output.txt`，真实 Agent 不可能通过。
- **用 `claude` 当 ACP**：协议不兼容，必须 `claude-code-acp`。
- **不让写 `~/.claude` / `~/.dsh`**：adapter 会因会话/缓存写失败而中断。
- **用 `--agent-network allowlist` 但没给模型域名**：Agent 无法访问模型 API；本地受信场景用默认 `agent-managed`。
- **把 bench 当成 LLM Brain 质量基准**：Brain 仍是 ScriptedBrain；它只验证“真实执行 + 验收”链路。
