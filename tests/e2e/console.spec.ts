import { expect, test } from '@playwright/test'

const token = 'e2e-token'
const thread = {
  id: 't1',
  title: 'Fix login redirect loop',
  goalId: 'g1',
  taskId: 'task1',
  status: 'completed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const messages = [
  {
    id: 'm1',
    threadId: 't1',
    role: 'user',
    kind: 'text',
    content: 'Fix the login redirect loop',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'm2',
    threadId: 't1',
    role: 'assistant',
    kind: 'result',
    content: 'Task completed: task1',
    taskId: 'task1',
    createdAt: new Date().toISOString(),
  },
]
const task = {
  id: 'task1',
  goalId: 'g1',
  title: 'Fix login redirect loop',
  status: 'completed',
  description: 'Fix the login redirect loop',
  createdAt: new Date().toISOString(),
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('hubagent_token', value)
    localStorage.setItem('hubagent.locale', 'en-US')
  }, token)
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/tasks/task1') return route.fulfill({ json: { ok: true, task, subtasks: [], executions: [], verifications: [], approvals: [] } })
    if (path === '/api/v1/tasks/task1/decisions') return route.fulfill({ json: { ok: true, decisions: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 2 }] } })
    if (path === '/api/v1/chat/threads/t1') return route.fulfill({ json: { ok: true, thread, messages } })
    if (path === '/api/v1/chat/threads/t1/messages') return route.fulfill({ json: { ok: true, thread, messages } })
    if (path === '/api/v1/chat/threads/t1/resume') return route.fulfill({ json: { ok: true, thread, messages } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })
})

test('route-based chat, tasks navigation, theme and language controls', async ({ page }) => {
  await page.goto('/chat/t1')
  await expect(page).toHaveURL(/\/chat\/t1$/)
  await expect(page.getByText('Fix the login redirect loop')).toBeVisible()
  await expect(page.getByText('Task completed: task1')).toBeVisible()

  await page.getByRole('link', { name: 'Tasks' }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  const before = await page.locator('meta[name="color-scheme"]').getAttribute('content')
  await page.getByRole('button', { name: /^Theme:/ }).click()
  const after = await page.locator('meta[name="color-scheme"]').getAttribute('content')
  expect(after).not.toBe(before)

  await page.getByRole('button', { name: 'Language' }).click()
  // The locale switch renames the controls; the shell must stay mounted and usable.
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('link', { name: '任务' })).toBeVisible()
})

test('context pane collapses and composer remains usable', async ({ page }) => {
  await page.goto('/chat/t1')
  const context = page.getByRole('complementary', { name: 'Thread context' })
  await expect(context).toBeVisible()
  await page.getByRole('button', { name: 'Collapse context' }).click()
  // Collapsed leaves the vertical rail in place, so the pane can be reopened.
  await expect(context.getByRole('button', { name: 'Expand context' }).first()).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Describe a task, or ask what is happening…' })).toBeVisible()
})


test('renders only the latest page and loads older messages', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const all = Array.from({ length: 1000 }, (_, index) => ({
    id: `m${index}`,
    threadId: 't1',
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    content: `message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }))
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 1000 }] } })
    if (path === '/api/v1/chat/threads/t1') {
      const before = url.searchParams.get('before')
      const source = before === null ? all : all.filter((message) => message.createdAt < before)
      return route.fulfill({ json: { ok: true, thread, messages: source.slice(-100) } })
    }
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/chat/t1')
  const transcript = page.getByRole('log').locator('article')
  await expect(transcript).toHaveCount(100)
  await page.getByRole('button', { name: 'Load older messages' }).click()
  await expect(transcript).toHaveCount(200)
})
