import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadRemotePeers } from '../../src/runtime/remote-endpoints'

function fixture(name: string): string {
  return new URL(`../fixtures/a2a-tls/${name}`, import.meta.url).pathname
}

describe('出站对端注册表', () => {
  it('token 模式：给 Brain 的最小信息与执行时的连接信息分开给', () => {
    const registry = loadRemotePeers([
      {
        id: 'peer-b',
        displayName: 'B 机器',
        url: 'https://b.example:7789/a2a',
        token: 'tok',
        capabilities: ['code'],
      },
    ])

    /* Brain 只能看到 id / 名字 / 能力——看不到 token。 */
    expect(registry.peers).toEqual([
      { id: 'peer-b', displayName: 'B 机器', capabilities: ['code'] },
    ])
    expect(JSON.stringify(registry.peers)).not.toContain('tok')

    expect(registry.resolvePeer('peer-b')).toEqual({
      url: 'https://b.example:7789/a2a',
      token: 'tok',
    })
    expect(registry.resolvePeer('peer-unknown')).toBeUndefined()
  })

  it('mTLS 模式：启动时读取证书文件', () => {
    const registry = loadRemotePeers([
      {
        id: 'peer-c',
        displayName: 'C',
        url: 'https://c.example/a2a',
        tls: {
          certFile: fixture('client-a.crt'),
          keyFile: fixture('client-a.key'),
          caFile: fixture('ca.crt'),
          serverName: 'c.example',
        },
      },
    ])

    const endpoint = registry.resolvePeer('peer-c')
    expect(endpoint?.token).toBeUndefined()
    const cert = endpoint?.tls?.cert
    expect(Buffer.isBuffer(cert)).toBe(true)
    expect(endpoint?.tls?.serverName).toBe('c.example')
    expect((cert as Buffer).equals(readFileSync(fixture('client-a.crt')))).toBe(true)
  })

  it('既没有 token 也没有证书 → 配置错误（fail-closed）', () => {
    expect(() =>
      loadRemotePeers([{ id: 'x', displayName: 'X', url: 'https://x.example/a2a' }]),
    ).toThrow(/必须至少配置 token 或 tls/)
  })

  it('id 重复 → 配置错误', () => {
    expect(() =>
      loadRemotePeers([
        { id: 'dup', displayName: 'A', url: 'https://a.example/a2a', token: 't' },
        { id: 'dup', displayName: 'B', url: 'https://b.example/a2a', token: 't' },
      ]),
    ).toThrow(/id 重复/)
  })

  it('证书文件缺失 → 启动期就失败，而不是等真正委托时', () => {
    expect(() =>
      loadRemotePeers([
        {
          id: 'broken',
          displayName: 'Broken',
          url: 'https://broken.example/a2a',
          tls: { certFile: '/nonexistent/client.crt', keyFile: '/nonexistent/client.key' },
        },
      ]),
    ).toThrow(/证书文件读不到/)
  })
})
