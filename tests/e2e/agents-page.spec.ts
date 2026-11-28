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

test('agent activity stays in the center pane and onboarding lives in settings', async ({
  page,
}) => {
  /* 现场是目的地（左栏一项），接入属于配置（设置里的一节），两者不再并列成分段。 */
  await page.setViewportSize({ width: 390, height: 820 })
  await page.route('**/api/v1/**', harness(presence.agents, emptyScan))
  await page.goto('/agents')

  await expect(page.getByRole('heading', { name: 'Agent activity', exact: true })).toBeVisible()

  const access = page.getByRole('link', { name: 'Agent access', exact: true })
  await expect(access).toBeVisible()
  await access.click()

  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connect' })).toBeVisible()
})

test('an empty floor leads straight to connecting an agent', async ({ page }) => {
  await page.route('**/api/v1/**', harness([], emptyScan))
  await page.goto('/agents')

  await expect(page.getByText('No agents on the floor yet.')).toBeVisible()
  await page.getByRole('link', { name: 'Connect an agent' }).click()

  /* 旧地址 `/registry` 会 replace 到设置里的接入一节：书签不失效，也不维护第二个入口。 */
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect(page.getByText('No connectable agents found on this machine.')).toBeVisible()
  /* 零 Agent 时给的是能执行的那一步：CLI 注册命令，不是一句“再试试”。 */
  await expect(page.getByText('hubagent agent add --name <name> --cmd "<command>"')).toBeVisible()
})
