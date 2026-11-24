# Regression tasks（V1.0 基线）

24 个任务描述符：20 个正常任务、4 个负例（应判 fail），其中 3 个标记 `shouldNotSplit`。

默认 `pnpm bench` 使用确定性 mock ACP agent 跑编排/验收链路，报告里 `mode=mock`。这**不是 LLM 规划质量基准**，而是回归基线：验证任务创建、Brain 决策、ACP 执行、验收、恢复探针不漂移。

接真实 harness：

```bash
pnpm bench --suite fixtures/regression-tasks --out reports/baseline.json \
  --agent-command 'your-acp-agent --flag'
```

真实模式下任务是否完成仍只由 `checks` 判定，不采信 Agent 自述。
