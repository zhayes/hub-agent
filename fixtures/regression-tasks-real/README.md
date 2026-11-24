# Real harness regression tasks（示例）

这是给真实 Claude Code / DSH harness 用的**任务级** suite，不是 mock 基线。

与 `fixtures/regression-tasks` 的区别：

- checks 针对真实仓库文件/测试，不再依赖 `mock-output.txt`；
- 每个任务可用 `files` 预置一个小仓库；
- 默认 `diffScope` 限定修改范围，越界会判 fail。

先跑一条任务确认链路：

```bash
pnpm bench --suite fixtures/regression-tasks-real \
  --out reports/real-agent.json \
  --agent-command 'claude-code-acp' \
  --agent-allow-write "$HOME/.claude"
```

接 DSH 的 ACP 入口见仓库文档；`--agent-allow-write` 用来放行 harness 自己的状态目录，**不要**放行项目根之外的源码目录。

要做 20–30 个真实任务，按同样格式复制 JSON：`files` 预置仓库、`checks` 写可执行验收、`diffScope` 收紧范围；不要为了让 Agent 通过而放宽检查。

完整操作见 [docs/REAL-HARNESS-BENCH.md](../../docs/REAL-HARNESS-BENCH.md)。
