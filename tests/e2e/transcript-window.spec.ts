import { expect, test } from '@playwright/test'

/**
 * 长历史不许把首屏拖死（UI-SPEC §9「10k 消息滚动不掉帧」）。
 *
 * 结构上做了两件事：历史按 100 条一页从服务端拉；DOM 只保留最近 200 个回合
 * （`ChatView` 的 `visibleTurns`）。没有窗口时实测 10k 条首屏 36s、单次长任务 17.6s；
 * 加窗口后 1.3s / <0.5s，DOM 恒为 400 行左右。
 *
 * 这里断言的是一条**能长期守住的下线**，不是精确性能数字：
 * 1. DOM 行数不随历史增长（窗口还在）；
 * 2. 不出现 >1.5s 的长任务（窗口被拿掉时会是十几秒）。
 */

const count = 10_000

const thread = {
  id: 't1',
  title: 'Very long history',
  goalId: 'g1',
  status: 'completed',
  permissionMode: 'workspace-write',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const messages = Array.from({ length: count }, (_, index) => ({
  id: `m${index}`,
  threadId: 't1',
  role: index % 2 === 0 ? 'user' : 'assistant',
  kind: 'text',
  content: `message ${index}: ` + 'lorem ipsum dolor sit amet '.repeat(3),
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - index * 1000).toISOString(),
}))

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('hubagent_token', value)
    localStorage.setItem('hubagent.locale', 'en-US')
  }, 'e2e-token')
})

test('a 10k-message history renders through the window, not all at once', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] }
    w.__longTasks = []
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration))
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      /* 没有 longtask 就不测这一项 */
    }
  })

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/chat/threads')
      return route.fulfill({
        json: { ok: true, threads: [{ ...thread, messageCount: count }] },
      })
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread, messages } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/chat/t1')
  const rows = page.getByRole('log').locator('article')
  await expect(rows.first()).toBeVisible({ timeout: 60_000 })

  /* 窗口生效：DOM 行数恒定在 400 上下（200 回合 × 用户+助手），不是 10000。 */
  const rendered = await rows.count()
  expect(rendered).toBeLessThan(600)
  expect(rendered).toBeGreaterThan(100)

  /* 被窗口挡住的仍然在内存里：一个按钮就能展开，不必再请求。 */
  const showOlder = page.getByRole('button', { name: /Show \d+ earlier turns/ })
  await expect(showOlder).toBeVisible()
  const before = rendered
  await showOlder.click()
  await expect
    .poll(async () => rows.count())
    .toBeGreaterThan(before)

  /* 滚一遍：只要不留十几秒的长任务（窗口被拿掉时会）。 */
  const box = await page.getByRole('log').boundingBox()
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.move((box?.x ?? 0) + 120, (box?.y ?? 0) + 120)
    await page.mouse.wheel(0, -3000)
    await page.waitForTimeout(50)
  }

  const longTasks = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  )
  const worst = longTasks.length === 0 ? 0 : Math.max(...longTasks)
  expect(worst, `worst long task ${worst}ms (all: ${longTasks.join(", ")})`).toBeLessThan(1_500)
})
