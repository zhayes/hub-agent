import type { Migration } from './001-init'

/**
 * 迁移 023：Peer 身份可以绑定到客户端证书（mTLS，ADR 0026 变更节）。
 *
 * 为什么要绑定证书而不是只看 token：bearer token 只能证明“拥有 token”，
 * 不绑定传输层身份；经 Relay 转发或暴露到更广网络时强度不够。
 *
 * `cert_fingerprint` 存 DER 的 sha256（小写 hex），**不存证书原文也不存私钥**。
 * 唯一约束是“部分索引”：未绑定证书的 peer（token 模式）可以有 NULL，且互不冲突。
 */
export const MIGRATION_023_A2A_PEER_CERT: Migration = {
  id: '023-a2a-peer-cert',
  sql: `
ALTER TABLE a2a_peers ADD COLUMN cert_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_peers_cert
  ON a2a_peers (cert_fingerprint) WHERE cert_fingerprint IS NOT NULL;
`,
}
