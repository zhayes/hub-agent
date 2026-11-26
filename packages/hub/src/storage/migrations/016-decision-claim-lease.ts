import type { Migration } from './001-init'

/**
 * 迁移 016：决策点 claim 需要「可验证的持有者」。
 *
 * - `claim_token`：每次 claim 生成；完成、失败、续租都必须带上它。
 *   否则进程崩溃后旧执行者仍能按 `id + status = 'claimed'` 收尾，把别人的
 *   工作标成完成（上一版 180s 租约就是因为缺这个字段而撤回的）。
 * - `attempts`：同一决策点被 claim 的次数。用于封顶重试，避免「回合总是
 *   超过租约」时被无限重复领取。
 */
export const MIGRATION_016_DECISION_CLAIM_LEASE: Migration = {
  id: '016-decision-claim-lease',
  sql: `
ALTER TABLE decision_queue ADD COLUMN claim_token TEXT;
ALTER TABLE decision_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_decision_queue_claimed ON decision_queue (status, claimed_at);
`,
}
