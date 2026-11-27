import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub } from '../../src/interfaces/http/server'
import { configPath } from '../../src/shared/paths'

const dirs: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function homeWithConfig(content: string): string {
  const home = mkdtempSync(join(tmpdir(), 'hubagent-a2a-config-'))
  dirs.push(home)
  writeFileSync(configPath(home), content, 'utf8')
  return home
}

describe('配置驱动的 A2A（生产接线）', () => {
  it('配置文件启用 a2a 后，daemon 自动起入站面（不传 options.a2a）', async () => {
    const home = homeWithConfig(`
[a2a]
enabled = true
port = 0
`)

    const hub = await startHub({ version: '0.0.0-test', home, port: 0, schedulerIntervalMs: 0 })
    closers.push(hub.close)

    expect(hub.a2a).toBeDefined()
    expect(hub.a2a?.url.startsWith('http://')).toBe(true)

    /* 卡片可访问：说明真的是一个能接活的入站面，而不是只回填了一个地址。 */
    const response = await fetch(
      `${hub.a2a?.url.replace(/\/a2a$/, '')}/.well-known/agent-card.json`,
    )
    expect(response.status).toBe(200)
    const card = (await response.json()) as { supportedInterfaces?: Array<{ url: string }> }
    expect(card.supportedInterfaces?.[0]?.url).toBe(hub.a2a?.url)
  })

  it('出站对端既无 token 也无证书时，daemon 拒绝启动', async () => {
    const home = homeWithConfig(`
[[a2a.remotePeers]]
id = "peer-b"
displayName = "B"
url = "https://b.example/a2a"
`)

    await expect(
      startHub({ version: '0.0.0-test', home, port: 0, schedulerIntervalMs: 0 }),
    ).rejects.toThrow(/必须至少配置 token 或 tls/)
  })

  it('配置了合法的出站对端时，daemon 正常启动', async () => {
    const home = homeWithConfig(`
[[a2a.remotePeers]]
id = "peer-b"
displayName = "B 机器"
url = "https://b.example:7789/a2a"
token = "outbound-token"
`)

    const hub = await startHub({ version: '0.0.0-test', home, port: 0, schedulerIntervalMs: 0 })
    closers.push(hub.close)

    /* 没启用入站面：出站配置不应把 A2A 监听器带起来。 */
    expect(hub.a2a).toBeUndefined()
  })
})
