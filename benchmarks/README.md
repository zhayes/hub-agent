# Benchmarks

`real-dsh-expanded.json`：2026-11-24，27 条真实任务（24 正例 + 3 负例），DSH ACP harness + DeepSeek。

```text
pnpm bench --suite fixtures/regression-tasks-real \
  --out reports/real-dsh-expanded.json \
  --agent-command "$DSH_ACP" \
  --agent-allow-write "$HOME/.dsh" ...
```

指标：

- autonomousCompletionRate = 1（24/24 正例）
- verificationMisjudgmentRate = 0（3/3 负例被拦）
- recoverySuccessRate = 1（恢复探针）
- overDecompositionRate = 0
- brainDecisionsPerTask ≈ 3.04（ScriptedBrain dispatch，不代表 LLM Brain 质量）
- averageDurationMs ≈ 18342

**注意**：这是 DSH 执行 + 验收基线，不是 LLM 规划质量基线；Brain 仍是 ScriptedBrain。
