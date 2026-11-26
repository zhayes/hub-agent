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
    if (path === '/api/v1/tasks/task1')
      return route.fulfill({
        json: { ok: true, task, subtasks: [], executions: [], verifications: [], approvals: [] },
      })
    if (path === '/api/v1/tasks/task1/decisions')
      return route.fulfill({ json: { ok: true, decisions: [] } })
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 2 }] } })
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread, messages } })
    if (path === '/api/v1/chat/threads/t1/messages')
      return route.fulfill({ json: { ok: true, thread, messages } })
    if (path === '/api/v1/chat/threads/t1/resume')
      return route.fulfill({ json: { ok: true, thread, messages } })
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
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: [{ ...activeThread, messageCount: 2 }] } })
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread: activeThread, messages } })
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

  const composer = page.getByRole('textbox', { name: /Ask anything/ })
  await composer.click()
  await page.keyboard.type('/')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: /New thread/ })).toBeVisible()
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
    if (path === '/api/v1/approvals')
      return route.fulfill({ json: { ok: true, approvals: [pending] } })
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

  /* Theme and language live in Settings only: the rail is a list of places,
     not a control panel. */
  await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)

  const before = await page.locator('meta[name="color-scheme"]').getAttribute('content')
  await page.getByRole('button', { name: 'Dark' }).click()
  const after = await page.locator('meta[name="color-scheme"]').getAttribute('content')
  expect(after).not.toBe(before)

  await page.getByRole('button', { name: '中文' }).click()
  // The locale switch renames the controls; the shell must stay mounted and usable.
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('link', { name: '任务' })).toBeVisible()
})

test('context pane collapses and reopens from the chat header', async ({ page }) => {
  await page.goto('/chat/t1')
  const context = page.getByRole('complementary', { name: 'Thread context' })
  await expect(context).toBeVisible()

  /* One toggle in the chat header owns the pane: collapsing removes it entirely
     (no 48px rail carrying its own expand button). */
  await page.getByRole('button', { name: 'Collapse context' }).click()
  await expect(context).toBeHidden()

  await page.getByRole('button', { name: 'Expand context' }).click()
  await expect(context).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Describe a task, or ask what is happening…' }),
  ).toBeVisible()
})

const providerRow = {
  providerId: 'deepseek',
  name: 'DeepSeek',
  modelId: 'deepseek-chat',
  modelIds: ['deepseek-chat'],
  api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeySet: true,
  apiKeyKind: 'literal',
  apiKeyHint: '…wxyz',
  isDefault: true,
}

const emptyModel = { agentDir: '/tmp/pi-agent', apiKeySet: false, apiKeyKind: 'none' }

/** Routes shared by the settings tests; `overrides` wins on path+method. */
function mockSettings(
  page: import('@playwright/test').Page,
  overrides: Record<string, (route: import('@playwright/test').Route) => Promise<void> | void>,
): Promise<void> {
  return page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    const handler = overrides[`${route.request().method()} ${path}`]
    if (handler !== undefined) return handler(route)
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })
}

test('settings model list adds a provider through the dialog', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const saved: Array<Record<string, unknown>> = []
  await mockSettings(page, {
    'GET /api/v1/settings/model': (route) =>
      route.fulfill({ json: { ok: true, model: emptyModel, providers: [] } }),
    'PUT /api/v1/settings/model': async (route) => {
      saved.push(route.request().postDataJSON() as Record<string, unknown>)
      await route.fulfill({
        json: {
          ok: true,
          model: { ...emptyModel, apiKeySet: true, apiKeyKind: 'literal' },
          providers: [providerRow],
        },
      })
    },
  })

  await page.goto('/settings')
  // 空列表直接给 DeepSeek 预填项（不落盘）
  await expect(page.getByRole('button', { name: 'Configure' })).toBeVisible()

  await page.getByRole('button', { name: 'Add provider' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // The suggested preset is pre-filled, not saved behind the user's back.
  await expect(dialog.getByLabel('Provider ID', { exact: true })).toHaveValue('deepseek')
  await expect(dialog.getByLabel('Model ID', { exact: true })).toHaveValue('deepseek-chat')

  await dialog.getByLabel('API Key', { exact: true }).fill('sk-1234wxyz')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect.poll(() => saved.length).toBe(1)
  expect(saved[0]).toMatchObject({
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    apiKey: 'sk-1234wxyz',
    makeDefault: true,
  })
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Saved.')).toBeVisible()
  // 保存即默认：列表里的徽章（不是对话框里的同名复选框）
  await expect(page.locator('span').filter({ hasText: /^Default$/ })).toHaveCount(1)
})

test('deleting a provider asks first, then removes it', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const deleted: string[] = []
  const alpha = { ...providerRow, providerId: 'alpha', name: 'Alpha', modelId: 'm-alpha' }
  const beta = { ...providerRow, providerId: 'beta', name: 'Beta', isDefault: false }
  await mockSettings(page, {
    'GET /api/v1/settings/model': (route) =>
      route.fulfill({ json: { ok: true, model: emptyModel, providers: [alpha, beta] } }),
    'DELETE /api/v1/settings/model/providers/alpha': async (route) => {
      deleted.push('alpha')
      await route.fulfill({ json: { ok: true, model: emptyModel, providers: [beta] } })
    },
  })

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Delete' }).first().click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/The key and model settings for Alpha/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect.poll(() => deleted).toEqual(['alpha'])
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Alpha', { exact: true })).toBeHidden()
  await expect(page.getByText('Beta', { exact: true })).toBeVisible()
})

test('collapsing the threads pane keeps the transcript column wide', async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 900 })
  await page.goto('/chat/t1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'Collapse threads' }).first().click()

  /* Regression: a collapsed pane is display:none, so the grid's auto-placement
     used to pull the remaining panes a column left — transcript 0px wide and the
     context pane swallowing the middle. */
  const transcript = await page.getByRole('region', { name: 'Chat' }).boundingBox()
  const context = await page.getByRole('complementary', { name: 'Thread context' }).boundingBox()
  expect(transcript?.width ?? 0).toBeGreaterThan(600)
  expect(context?.width ?? 0).toBeLessThan(400)
  await expect(page.getByRole('textbox', { name: /Describe a task/ })).toBeVisible()
})

test('below 1100px the context pane reserves no empty gutter', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.goto('/chat/t1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  /* The context pane is hidden below 1100px; the grid must not keep its column
     alive, or the transcript is squeezed by an invisible 300px strip. */
  const transcript = await page.getByRole('region', { name: 'Chat' }).boundingBox()
  const main = await page.getByRole('main').boundingBox()
  expect(transcript).not.toBeNull()
  expect(main).not.toBeNull()
  if (transcript !== null && main !== null) {
    expect(Math.abs(transcript.x + transcript.width - (main.x + main.width))).toBeLessThan(2)
  }
})

test('transcript and composer keep a readable measure on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/chat/t1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  const transcript = await page.getByRole('region', { name: 'Chat' }).boundingBox()
  const composer = await page.getByRole('textbox', { name: /Describe a task/ }).boundingBox()
  const message = await page.getByRole('article').first().boundingBox()
  // The pane is wide, but the text column is capped so lines stay scannable...
  expect(transcript?.width ?? 0).toBeGreaterThan(900)
  expect(composer?.width ?? 0).toBeLessThanOrEqual(700)
  // ...and the composer shares that measure, so both edges line up.
  expect(Math.abs((composer?.x ?? 0) - (message?.x ?? 0))).toBeLessThan(2)
  expect(Math.abs((composer?.width ?? 0) - (message?.width ?? 0))).toBeLessThan(2)
})

test('without a token chat shows one blocked card instead of empty panes', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('hubagent_token'))
  // Dev server answers /api with index.html when there is no daemon behind it.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>app</h1>' }),
  )

  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Daemon not connected' })).toBeVisible()
  await expect(page.getByText('Run pnpm ha web, then reload this page.')).toBeVisible()

  // One message, not three empty panes plus a banner saying the same thing.
  await expect(page.getByRole('complementary', { name: 'Thread context' })).toHaveCount(0)
  await expect(page.getByText('API token required')).toHaveCount(0)
  await expect(page.getByText(/Unexpected token/)).toHaveCount(0)
  // 不再有"去设置里粘 token"这条路：token 只能由 daemon 注入。
  await expect(page.getByRole('link', { name: 'Open settings' })).toHaveCount(0)
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
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 1000 }] } })
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

test('registry scans the built-in catalog and adopts an agent', async ({ page }) => {
  await page.unroute('**/api/v1/**')
  const scan = {
    ok: true,
    version: 1,
    scannedAt: new Date().toISOString(),
    problems: [],
    agents: [
      {
        catalogId: 'dsh',
        label: 'DSH',
        name: 'dsh',
        variants: [
          {
            id: 'desktop',
            label: 'Desktop',
            command: 'ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app" --profile acp',
            source: '/Applications/DeepSeek Harness.app',
            allowedWrite: ['/Users/me/.dsh'],
            missingRequires: [],
            adoptable: true,
          },
        ],
        chosenVariant: 'desktop',
        registered: false,
      },
      {
        catalogId: 'codex',
        label: 'Codex',
        name: 'codex',
        variants: [
          {
            id: 'adapter',
            label: 'adapter',
            command: 'codex-acp',
            source: '/Applications/ChatGPT.app',
            allowedWrite: [],
            missingRequires: ['codex-acp'],
            adoptable: false,
          },
        ],
        chosenVariant: 'adapter',
        registered: false,
      },
    ],
  }
  const adopted = {
    ok: true,
    agent: {
      id: 'a1',
      name: 'dsh',
      status: 'online',
      command: scan.agents[0]!.variants[0]!.command,
      networkMode: 'agent-managed',
      allowedWrite: ['/Users/me/.dsh'],
      catalogId: 'dsh',
    },
    probe: { ok: true, status: 'online', durationMs: 900, authMethods: [], stderrTail: [] },
  }

  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/agents/scan') return route.fulfill({ json: scan })
    if (path === '/api/v1/agents/adopt') return route.fulfill({ json: adopted })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/registry')
  await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible()
  await expect(page.getByText('DSH')).toBeVisible()
  await expect(page.getByText(/Missing: codex-acp/)).toBeVisible()

  await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await expect(page.getByText('dsh is connected.')).toBeVisible()

  await page.getByRole('button', { name: 'Agent details' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('ELECTRON_RUN_AS_NODE=1')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('registry does not overflow at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/registry')
  await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})
