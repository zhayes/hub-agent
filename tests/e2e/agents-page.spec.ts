import { expect, test } from '@playwright/test'

/* Agent 目的地（P7）：现场与接入是同一个页面的两个分段。 */

const token = 'e2e-token'

const presence = {
  ok: true,
  asOf: new Date().toISOString(),
  agents: [
    {
      id: 'a1',
      name: 'Claude Code',
      status: 'online',
      presence: 'online',
      networkMode: 'agent-managed',
      allowedWrite: [],
      allowedDomains: [],
      capabilities: [],
      parallelCount: 0,
      pendingApprovals: [],
    },
  ],
}

const emptyScan = {
  ok: true,
  version: 2,
  scannedAt: new Date().toISOString(),
  problems: [],
  agents: [],
}

function harness(agents: unknown, scan: unknown) {
  return async (route: import('@playwright/test').Route): Promise<void> => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/agents/presence') return route.fulfill({ json: { ...presence, agents } })
    if (path === '/api/v1/agents/scan') return route.fulfill({ json: scan })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('hubagent_token', value)
    localStorage.setItem('hubagent.locale', 'en-US')
  }, token)
})

test('both agent segments stay reachable in the page, even on a phone', async ({ page }) => {
  /* 分段控件在页面里而不是顶栏：顶栏 ≤560px 会把它藏掉，那时手机上就切不了分段。 */
  await page.setViewportSize({ width: 390, height: 820 })
  await page.route('**/api/v1/**', harness(presence.agents, emptyScan))
  await page.goto('/agents')

  const stage = page.getByRole('link', { name: 'Stage', exact: true })
  const access = page.getByRole('link', { name: 'Connect', exact: true })
  await expect(stage).toBeVisible()
  await expect(access).toBeVisible()
  await expect(stage).toHaveAttribute('aria-current', 'page')

  /* 顶栏只留一份页名（目的地页签 + 页内分段），不重复成“Agents Agents”。 */
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toHaveCount(1)

  await access.click()
  await expect(page).toHaveURL(/\/registry$/)
  await expect(access).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: 'Connect' })).toBeVisible()
})

test('an empty floor leads straight to connecting an agent', async ({ page }) => {
  await page.route('**/api/v1/**', harness([], emptyScan))
  await page.goto('/agents')

  await expect(page.getByText('No agents on the floor yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Connect an agent' }).click()

  await expect(page).toHaveURL(/\/registry$/)
  await expect(page.getByText('No connectable agents found on this machine.')).toBeVisible()
  /* 零 Agent 时给的是能执行的那一步：CLI 注册命令，不是一句“再试试”。 */
  await expect(page.getByText('hubagent agent add --name <name> --cmd "<command>"')).toBeVisible()
})
