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

test('chat stream appends pushed messages without polling', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const activeThread = { ...thread, status: 'active' }
  const streamed = {
    id: 'm-stream-1',
    threadId: 't1',
    role: 'assistant',
    kind: 'text',
    content: 'Pushed over the stream',
    createdAt: new Date().toISOString(),
  }
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/chat/threads/t1/stream') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: `id: 7\nevent: message\ndata: ${JSON.stringify(streamed)}\n\n`,
      })
    }
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [{ ...activeThread, messageCount: 2 }] } })
    if (path === '/api/v1/chat/threads/t1') return route.fulfill({ json: { ok: true, thread: activeThread, messages } })
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/chat/t1')
  await expect(page.getByText('Task completed: task1')).toBeVisible()
  await expect(page.getByText('Pushed over the stream')).toBeVisible()
})

test('composer slash menu and pane resize are keyboard reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat/t1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  const composer = page.getByRole('textbox', { name: /Describe a task/ })
  await composer.click()
  await page.keyboard.type('/')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: /Ask/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()

  const leftSplitter = page.getByRole('separator', { name: 'Threads' })
  await expect(leftSplitter).toBeVisible()
  const before = Number(await leftSplitter.getAttribute('aria-valuenow'))
  await leftSplitter.focus()
  await page.keyboard.press('ArrowRight')
  const after = Number(await leftSplitter.getAttribute('aria-valuenow'))
  expect(after).toBeGreaterThan(before)
})

test('approving from the approvals page confirms with a toast', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const pending = {
    id: 'ap1',
    taskId: 'task1',
    executionId: 'exe1',
    reason: 'Push the fix to origin',
    resource: 'git push origin fix/auth-redirect-loop',
    status: 'pending',
    riskLevel: 'high',
  }
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [pending] } })
    if (path.includes('/approve')) return route.fulfill({ json: { ok: true } })
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/approvals')
  await page.getByRole('button', { name: 'Approve' }).first().click()
  await expect(page.getByText('Approve', { exact: true }).last()).toBeVisible()
})

test('command palette jumps between screens and closes on escape', async ({ page }) => {
  await page.goto('/chat/t1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await page.keyboard.press('Meta+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await page.keyboard.type('approv')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/approvals$/)
  await expect(dialog).toBeHidden()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
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


test('settings model form saves provider, model and key', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const stored = {
    agentDir: '/tmp/pi-agent',
    providerId: 'local-proxy',
    modelId: 'qwen2.5-coder:7b',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeySet: true,
    apiKeyKind: 'literal',
    apiKeyHint: '…wxyz',
  }
  let patch: Record<string, unknown> | undefined
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/settings/model') {
      if (route.request().method() === 'PUT') {
        patch = route.request().postDataJSON() as Record<string, unknown>
        return route.fulfill({ json: { ok: true, model: stored } })
      }
      return route.fulfill({
        json: { ok: true, model: { agentDir: '/tmp/pi-agent', apiKeySet: false, apiKeyKind: 'none' } },
      })
    }
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/settings')
  // 未配置时 Save 不可用：Provider 与 Model ID 是必填项。
  const saveModel = page.locator('form').getByRole('button', { name: 'Save' })
  await expect(saveModel).toBeDisabled()

  await page.getByLabel('Provider', { exact: true }).fill('local-proxy')
  await page.getByLabel('Model ID', { exact: true }).fill('qwen2.5-coder:7b')
  await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:11434/v1')
  await page.getByLabel('API Key', { exact: true }).fill('sk-1234wxyz')
  await saveModel.click()

  await expect.poll(() => patch?.['providerId']).toBe('local-proxy')
  expect(patch?.['apiKey']).toBe('sk-1234wxyz')
  expect(patch?.['api']).toBe('openai-completions')

  // 保存后凭据从输入框清掉，只留提示，不再回显明文。
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(page.getByText('Key stored · …wxyz')).toBeVisible()
  await expect(page.getByText('Saved.')).toBeVisible()
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
