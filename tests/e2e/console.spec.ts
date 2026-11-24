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
  await page.addInitScript((value) => localStorage.setItem('hubagent_token', value), token)
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
  await expect(page.locator('.rail-nav')).toBeVisible()
})

test('context pane collapses and composer remains usable', async ({ page }) => {
  await page.goto('/chat/t1')
  const context = page.locator('.chat-context')
  await expect(context).toBeVisible()
  await page.locator('.chat-head-actions').getByRole('button', { name: 'Collapse context' }).click()
  await expect(context).toHaveClass(/collapsed/)
  await expect(page.getByRole('textbox', { name: 'Describe a task, or ask what is happening…' })).toBeVisible()
})
