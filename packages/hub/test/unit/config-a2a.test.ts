import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/shared/config'

async function tempConfig(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hubagent-config-a2a-'))
  const path = join(dir, 'config.toml')
  if (content !== undefined) await writeFile(path, content, 'utf8')
  return path
}

describe('a2a 配置段', () => {
  it('默认关闭，且没有对端', async () => {
    const loaded = await loadConfig(await tempConfig())
    expect(loaded.config.a2a.enabled).toBe(false)
    expect(loaded.config.a2a.peers).toEqual([])
    expect(loaded.config.a2a.remotePeers).toEqual([])
    expect(loaded.config.a2a.tls).toBeUndefined()
  })

  it('解析入站 peer、TLS 文件路径与出站对端', async () => {
    const loaded = await loadConfig(
      await tempConfig(`
[a2a]
enabled = true
port = 7789
host = "0.0.0.0"

[a2a.tls]
keyFile = "/etc/hub/server.key"
certFile = "/etc/hub/server.crt"
caFile = "/etc/hub/ca.crt"
requireClientCert = true

[[a2a.peers]]
displayName = "peer-a"
token = "inbound-token"
certFingerprint = "aabbcc"

[[a2a.remotePeers]]
id = "peer-b"
displayName = "B 机器"
url = "https://b.example:7789/a2a"
token = "outbound-token"

[[a2a.remotePeers]]
id = "peer-c"
displayName = "C 机器"
url = "https://c.example/a2a"

[a2a.remotePeers.tls]
certFile = "/etc/hub/client.crt"
keyFile = "/etc/hub/client.key"
caFile = "/etc/hub/ca.crt"
serverName = "c.example"
`),
    )

    const a2a = loaded.config.a2a
    expect(a2a.enabled).toBe(true)
    expect(a2a.port).toBe(7789)
    expect(a2a.host).toBe('0.0.0.0')
    expect(a2a.tls?.requireClientCert).toBe(true)
    expect(a2a.tls?.caFile).toBe('/etc/hub/ca.crt')
    expect(a2a.peers).toEqual([
      { displayName: 'peer-a', token: 'inbound-token', certFingerprint: 'aabbcc' },
    ])
    expect(a2a.remotePeers.map((peer) => peer.id)).toEqual(['peer-b', 'peer-c'])
    expect(a2a.remotePeers[1]?.tls?.serverName).toBe('c.example')
  })

  it('url 不是 http(s) 时报配置错误', async () => {
    await expect(
      loadConfig(
        await tempConfig(`
[[a2a.remotePeers]]
id = "peer-b"
displayName = "B"
url = "b.example:7789"
token = "t"
`),
      ),
    ).rejects.toThrow(/配置校验失败/)
  })
})
