# A2A mTLS 测试证书（仅测试）

`a2a-mtls.test.ts` 用这些证书验证 A2A 入站面的双向 TLS：

| 文件                                    | 用途                                               |
| --------------------------------------- | -------------------------------------------------- |
| `ca.crt` / `ca.key`                     | 受信 CA，服务端与客户端都信任它                    |
| `server.crt` / `server.key`             | 服务端证书（SAN：`DNS:localhost`、`IP:127.0.0.1`） |
| `client-a.crt` / `client-a.key`         | 受信 CA 签发的客户端证书（模拟 peer-a）            |
| `client-b.crt` / `client-b.key`         | 同上（模拟 peer-b，用于“已签发但未注册”的用例）    |
| `rogue-ca.crt` / `rogue-ca.key`         | 不受信 CA                                          |
| `rogue-client.crt` / `rogue-client.key` | 由 rogue CA 签发，验证握手阶段即被拒               |

## 安全说明

这些私钥**只用于测试**，随仓库公开：

- 由 `regenerate.sh` 现场生成，没有任何真实用途；
- `ca.crt` 不得被任何真实服务信任；
- 有效期 36500 天，避免测试因证书过期而失败。

需要重新生成时：

```sh
cd packages/hub/test/fixtures/a2a-tls && sh regenerate.sh
```
