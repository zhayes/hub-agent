import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/* Page-level baselines. Everything time-relative is pinned: the clock is fixed,
   the mocked threads are completed (no polling, no ticking loading line) and
   motion is reduced, so a diff means the layout or colours actually changed. */
const FIXED_NOW = new Date('2026-01-01T12:00:00Z')

const task = {
  id: 'task1',
  goalId: 'g1',
  title: 'Fix the login redirect loop',
  status: 'running',
  description: 'RequireSession redirects before the cookie is readable.',
  createdAt: '2026-01-01T11:56:00Z',
}
const approval = {
  id: 'ap1',
  taskId: 'task1',
  executionId: 'exe1',
  reason: 'Push the fix to origin',
  resource: 'git push origin fix/auth-redirect-loop',
  status: 'pending',
  riskLevel: 'high',
}
const thread = {
  id: 't1',
  title: 'Fix login redirect loop',
  goalId: 'g1',
  taskId: 'task1',
  status: 'completed',
  createdAt: '2026-01-01T11:50:00Z',
  updatedAt: '2026-01-01T11:58:00Z',
}
const conversations = [
  { ...thread, messageCount: 5, lastMessage: 'Pushed and verified' },
  {
    id: 't2',
    title: 'Rotate the staging bearer token',
    goalId: 'g2',
    status: 'completed',
    createdAt: '2026-01-01T09:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    messageCount: 4,
    lastMessage: 'Token rotated and verified',
  },
]
const messages = [
  {
    id: 'm1',
    threadId: 't1',
    role: 'user',
    kind: 'text',
    content: 'Fix the login redirect loop',
    createdAt: '2026-01-01T11:51:00Z',
  },
  {
    id: 'm2',
    threadId: 't1',
    role: 'assistant',
    kind: 'plan',
    content: 'Three steps: reproduce, patch the cookie read order, verify /dashboard.',
    createdAt: '2026-01-01T11:52:00Z',
  },
  {
    id: 'm3',
    threadId: 't1',
    role: 'assistant',
    kind: 'task',
    content: 'Delegated to Claude Code',
    taskId: 'task1',
    createdAt: '2026-01-01T11:53:00Z',
  },
  {
    id: 'm4',
    threadId: 't1',
    role: 'assistant',
    kind: 'approval',
    content: 'Push the fix to origin',
    approvalId: 'ap1',
    createdAt: '2026-01-01T11:55:00Z',
  },
  {
    id: 'm5',
    threadId: 't1',
    role: 'assistant',
    kind: 'clarification',
    content: 'Should the fix also cover the legacy /auth/login path?',
    clarificationId: 'cl1',
    createdAt: '2026-01-01T11:57:00Z',
  },
  {
    id: 'm6',
    threadId: 't1',
    role: 'assistant',
    kind: 'result',
    content: 'Task completed: task1',
    taskId: 'task1',
    createdAt: '2026-01-01T11:58:00Z',
  },
]

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: conversations } })
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread, messages } })
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/tasks/task1')
      return route.fulfill({
        json: {
          ok: true,
          task,
          subtasks: [
            {
              id: 's1',
              title: 'Reproduce the redirect with a session cookie',
              status: 'completed',
              required: true,
            },
            { id: 's2', title: 'Move the cookie read after jar sync', status: 'running', required: true },
          ],
          executions: [
            {
              id: 'exe1',
              status: 'running',
              attempt: 2,
              evidence: {
                branch: 'fix/auth-redirect-loop',
                commitSha: '9f2c41ad8123',
                diffstat: ' src/auth/session.ts | 14 +++++-----\n 2 files changed, +14 −8',
              },
            },
          ],
          verifications: [
            {
              id: 'ver1',
              executionId: 'exe1',
              verdict: 'passed',
              checks: [
                {
                  checkId: 'c1',
                  kind: 'unit',
                  passed: true,
                  command: 'pnpm vitest run auth --reporter=dot',
                  exitCode: 0,
                },
              ],
            },
          ],
          approvals: [approval],
        },
      })
    if (path === '/api/v1/tasks/task1/decisions')
      return route.fulfill({
        json: {
          ok: true,
          decisions: [
            {
              id: 'd1',
              type: 'retry',
              rationale: 'First attempt hit a flaky fixture; retried with a frozen clock.',
              decidedAt: '2026-01-01T11:54:00Z',
            },
          ],
        },
      })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents: [] } })
    if (path === '/api/v1/approvals')
      return route.fulfill({ json: { ok: true, approvals: [approval] } })
    return route.fulfill({ json: { ok: true } })
  })
}

const cases = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
] as const

const pages = [
  { name: 'chat', path: '/chat/t1' },
  { name: 'tasks', path: '/tasks/task1' },
] as const

const themes = ['light', 'dark'] as const

for (const theme of themes) {
  for (const item of cases) {
    for (const target of pages) {
      test(`${target.name} ${theme} ${item.name}`, async ({ page }) => {
        await page.clock.setFixedTime(FIXED_NOW)
        await page.setViewportSize({ width: item.width, height: item.height })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.addInitScript((value) => {
          localStorage.setItem('hubagent_token', 'visual-token')
          localStorage.setItem('hubagent.theme', value)
          localStorage.setItem('hubagent.locale', 'en-US')
        }, theme)
        await mockApi(page)

        await page.goto(target.path)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        await page.evaluate(() => document.fonts.ready)

        await expect(page).toHaveScreenshot(`${target.name}-${theme}-${item.name}.png`, {
          animations: 'disabled',
          threshold: 0.05,
          maxDiffPixelRatio: 0.002,
        })
      })
    }
  }
}

for (const target of pages) {
  test(`${target.name} has no critical or serious axe violations`, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_NOW)
    await page.addInitScript(() => {
      localStorage.setItem('hubagent_token', 'visual-token')
      localStorage.setItem('hubagent.locale', 'en-US')
    })
    await mockApi(page)
    await page.goto(target.path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    )

    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
      JSON.stringify(blocking, null, 2),
    ).toEqual([])
  })
}
