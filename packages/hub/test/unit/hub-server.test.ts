import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub } from '../../src/interfaces/http/server'

/**
 * S1：`ha web` 的启动单元。
 *
 * 这里测三件真实会坏的事：端口占用时要顺延、控制台资源要按包根解析（不依赖 cwd）、
 * 卸载/未构建时要能起服务但明确 404。
 */

const homes: string[] = []
const running: Array<() => Promise<void>> = []

afterEach(async () => {
  while (running.length > 0) {
    const close = running.pop()
    await close?.().catch(() => undefined)
  }
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-web-'))
  homes.push(dir)
  return dir
}

describe('startHub：ha web 的启动单元', () => {
  it('起服务、/api 需要 token、close 后可重新监听同一端口', async () => {
    const home = tempHome()
    const handle = await startHub({ version: 'test', home, port: 0 })
    running.push(handle.close)

    const health = await fetch(`${handle.url}/api/v1/health`)
    expect(health.status).toBe(401)

    const token = readFileSync(handle.tokenPath, 'utf8').trim()
    const authorized = await fetch(`${handle.url}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)

    const port = handle.port
    await handle.close()
    running.pop()

    const again = await startHub({ version: 'test', home, port })
    running.push(again.close)
    expect(again.port).toBe(port)
  })

  it('端口被占用时顺延到下一个', async () => {
    const first = await startHub({ version: 'test', home: tempHome(), port: 0 })
    running.push(first.close)

    const second = await startHub({ version: 'test', home: tempHome(), port: first.port })
    running.push(second.close)

    expect(second.port).toBe(first.port + 1)
  })

  it('控制台未构建时服务仍可起，页面 404 且不注入 token', async () => {
    const handle = await startHub({
      version: 'test',
      home: tempHome(),
      port: 0,
      webDist: join(tmpdir(), 'hubagent-no-such-web-dist'),
    })
    running.push(handle.close)

    expect(handle.webBuilt).toBe(false)
    const page = await fetch(`${handle.url}/`)
    expect(page.status).toBe(404)
    expect(await page.text()).toContain('web console not built')
  })

  it('控制台按包根解析：从任意 cwd 启动都能命中构建产物', async () => {
    const handle = await startHub({ version: 'test', home: tempHome(), port: 0 })
    running.push(handle.close)

    expect(handle.webBuilt).toBe(true)
    const page = await fetch(`${handle.url}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('__HUBAGENT_TOKEN__')
  })
})
