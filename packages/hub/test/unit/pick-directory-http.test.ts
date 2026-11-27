import { afterEach, describe, expect, it } from 'vitest'
import type { PickDirectoryOutcome } from '../../src/agent-host/native-picker'
import { createHttpApp } from '../../src/interfaces/http/app'
import { type Db, openDatabase } from '../../src/storage/db'
import { migrate } from '../../src/storage/migrate'

const dbs: Db[] = []
const TOKEN = 'test-token'

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

function db(): Db {
  const value = openDatabase(':memory:')
  migrate(value)
  dbs.push(value)
  return value
}

function appWith(outcome: PickDirectoryOutcome) {
  return createHttpApp({
    db: db(),
    token: TOKEN,
    pickDirectory: async () => outcome,
  })
}

function post(app: ReturnType<typeof createHttpApp>, token = TOKEN) {
  return app.request('/api/v1/fs/pick-directory', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('系统目录选择框接口', () => {
  it('未认证被拒', async () => {
    const response = await appWith({ kind: 'cancelled' }).request('/api/v1/fs/pick-directory', {
      method: 'POST',
    })
    expect(response.status).toBe(401)
  })

  it('选中目录 → 200 + 路径', async () => {
    const response = await post(appWith({ kind: 'picked', path: '/Users/chad/proj' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, path: '/Users/chad/proj' })
  })

  it('用户取消 → 200 + cancelled（不是错误）', async () => {
    const response = await post(appWith({ kind: 'cancelled' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, cancelled: true })
  })

  it('已有弹框在等待 → 409', async () => {
    const response = await post(appWith({ kind: 'busy' }))
    expect(response.status).toBe(409)
  })

  it('平台不支持 → 501（前端降级为手填）', async () => {
    const response = await post(appWith({ kind: 'unsupported' }))
    expect(response.status).toBe(501)
  })
})
