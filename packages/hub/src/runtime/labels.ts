/**
 * 枚举 → 人话。
 *
 * 对话正文（chat）是用户直接读的，禁止把 `pass` / `end_turn` 这类协议值拼进去：
 * 之前 `执行完成（验收 pass）` 就是漏出来的（PLAN-CONSOLE-INTERACTION §3.6）。
 * 只放展示用词，不参与任何判定。
 */

const VERDICT_LABELS: Readonly<Record<string, string>> = {
  pass: '通过',
  fail: '未通过',
  manual_required: '需人工确认',
  not_run: '未执行',
}

/** ACP 的 prompt stop reason（`acp-run.ts` 直传，未翻译过）。 */
const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  end_turn: '正常结束',
  max_tokens: '超出上下文上限',
  max_turn_requests: '超出轮次上限',
  refusal: 'Agent 拒绝继续',
  cancelled: '已取消',
}

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict
}

export function stopReasonLabel(stopReason: string): string {
  return STOP_REASON_LABELS[stopReason] ?? stopReason
}
