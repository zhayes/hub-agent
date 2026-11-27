#!/bin/sh
# 重新生成 mTLS 测试证书（`packages/hub/test/unit/a2a-mtls.test.ts` 使用）。
#
# 这些证书**只用于测试**：全部由本脚本生成、没有任何真实用途、可以公开。
# 不要把它们复制到生产环境，也不要让任何真实服务信任 ca.crt。
#
# 用法：cd packages/hub/test/fixtures/a2a-tls && sh regenerate.sh
set -eu

DAYS=36500
CA_SUBJ="/CN=HubAgent Test CA"
ROGUE_CA_SUBJ="/CN=HubAgent Rogue CA"

rm -f ./*.crt ./*.key ./*.csr ./*.srl

# 受信 CA
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout ca.key -out ca.crt -subj "$CA_SUBJ" 2>/dev/null

# 服务端证书（SAN 覆盖 localhost 与 127.0.0.1，供 127.0.0.1 回环测试）
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -extfile server.ext 2>/dev/null

# 受信 CA 签发的两个客户端证书（对应 peer-a / peer-b）
for name in client-a client-b; do
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$name" 2>/dev/null
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -days "$DAYS" -extfile client.ext 2>/dev/null
done

# 不受信的 CA 及其签发的客户端证书（验证握手阶段就被拒）
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout rogue-ca.key -out rogue-ca.crt -subj "$ROGUE_CA_SUBJ" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout rogue-client.key -out rogue-client.csr \
  -subj "/CN=rogue-client" 2>/dev/null
openssl x509 -req -in rogue-client.csr -CA rogue-ca.crt -CAkey rogue-ca.key -CAcreateserial \
  -out rogue-client.crt -days "$DAYS" -extfile client.ext 2>/dev/null

rm -f ./*.csr ./*.srl
echo "regenerated: ca, server, client-a, client-b, rogue-ca, rogue-client"
