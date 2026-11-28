import { expect, test } from '@playwright/test'

/* 任务详情 / 任务列表（P5）。用的是真实前端 + 打桩接口。 */

const token = 'e2e-token'

const task = {
  id: 'task1',
  goalId: 'g1',
  title: 'Fix login redirect loop',
  status: 'completed',
  description: 'next 参数必须限制为站内路径。',
  createdAt: new Date().toISOString(),
}

const thread = {
  id: 't1',
  title: 'Fix login redirect loop',
  goalId: 'g1',
  taskId: 'task1',
  status: 'completed',
  permissionMode: 'workspace-write',
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
]

const pending = {
  id: 'ap1',
  taskId: 'task1',
  executionId: 'exe2',
  reason: 'Install the test dependency',
  resource: 'npm install --no-save playwright-core',
  status: 'pending',
  riskLevel: 'medium',
  action: 'sandbox.relax',
  decisionMode: 'once',
}

const detail = {
  ok: true,
  task,
  subtasks: [
    {
      id: 'sub1',
      taskId: 'task1',
      title: 'Fix the redirect',
      status: 'completed',
      required: true,
      assignedAgentId: 'agent1',
    },
  ],
  executions: [
    {
      id: 'exe1',
      taskId: 'task1',
      status: 'failed',
      attempt: 1,
      agentId: 'agent1',
      failureCategory: 'verification',
    },
    {
      id: 'exe2',
      taskId: 'task1',
      status: 'completed',
      attempt: 2,
      agentId: 'agent1',
      evidence: {
        branch: 'fix/login',
        commitSha: '3fa91c7d9e2b',
        diffstat: ' src/a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)',
        changedFiles: ['src/a.ts'],
      },
    },
  ],
  verifications: [
    {
      id: 'v1',
      executionId: 'exe2',
      verdict: 'fail',
      checks: [
        {
          checkId: 'c1',
          kind: 'test:unit',
          passed: false,
          command: 'pnpm test:unit',
          exitCode: 1,
          outputRef: 'artifacts/test.log',
        },
      ],
    },
  ],
  approvals: [pending],
}

function harness(approvals: () => unknown[]) {
  return async (route: import('@playwright/test').Route): Promise<void> => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents')
      return route.fulfill({
        json: {
          ok: true,
          agents: [
            {
              id: 'agent1',
              name: 'Claude Code',
              status: 'online',
              command: 'claude',
              networkMode: 'proxy',
            },
          ],
        },
      })
    if (path === '/api/v1/approvals')
      return route.fulfill({ json: { ok: true, approvals: approvals() } })
    if (path.endsWith('/approve')) return route.fulfill({ json: { ok: true } })
    if (path === '/api/v1/tasks/task1')
      return route.fulfill({ json: { ...detail, approvals: approvals() } })
    if (path === '/api/v1/tasks/task1/decisions')
      return route.fulfill({ json: { ok: true, decisions: [] } })
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 2 }] } })
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread, messages } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('hubagent_token', value)
    localStorage.setItem('hubagent.locale', 'en-US')
  }, token)
})

test('task detail keeps the verdict next to its evidence and approves in place', async ({
  page,
}) => {
  let approved = 0
  const approvals = (): unknown[] => (approved === 0 ? [pending] : [])
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/approve')) approved += 1
    await harness(approvals)(route)
  })

  await page.goto('/tasks/task1')

  /* 结论在运行详情顶部，证据（diffstat 与失败的那条检查）紧挨着它（§5.4 / US-008）。 */
  const panel = page.getByRole('complementary', { name: 'Task progress' })
  await expect(
    panel.getByRole('heading', { name: 'Fix login redirect loop', level: 2 }),
  ).toBeVisible()
  await expect(panel.getByText('Verification failed', { exact: true })).toBeVisible()
  await expect(panel.getByText('+2', { exact: true })).toBeVisible()
  await expect(panel.getByText('pnpm test:unit', { exact: true }).first()).toBeVisible()
  await expect(panel.getByText('artifacts/test.log', { exact: true })).toBeVisible()
  /* 来源对话是双向可达的那一半（§4.3）。 */
  await expect(panel.getByRole('link', { name: /From conversation/ })).toBeVisible()

  /* 脊柱节点是按钮：键盘能展开，不是只有鼠标能点。 */
  const plan = panel.getByRole('button', { name: /Plan/ })
  await expect(plan).toHaveAttribute('aria-expanded', 'false')
  await plan.focus()
  await page.keyboard.press('Enter')
  await expect(plan).toHaveAttribute('aria-expanded', 'true')

  /* 审批就地做：不跳页，也不再问一遍。 */
  await panel.getByRole('button', { name: 'Allow once' }).click()
  await expect.poll(() => approved).toBe(1)

  await panel.getByRole('link', { name: /From conversation/ }).click()
  await expect(page).toHaveURL(/\/chat\/t1$/)
})

test('task list is a deep-link entry into a run', async ({ page }) => {
  await page.route(
    '**/api/v1/**',
    harness(() => []),
  )
  await page.goto('/tasks')
  const row = page.getByRole('link', { name: /Fix login redirect loop/ })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(/\/tasks\/task1$/)
  await expect(page.getByText('Verification failed', { exact: true })).toBeVisible()
})
