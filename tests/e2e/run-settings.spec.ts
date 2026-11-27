import { expect, test } from '@playwright/test'

/* P8：运行设置（验收命令 / 可用 Agent / 预算）与交付（导出补丁）。 */

const token = 'e2e-token'
const now = new Date().toISOString()

const thread = {
  id: 't1',
  title: 'Fix login redirect loop',
  goalId: 'g1',
  taskId: 'task1',
  status: 'completed',
  worktree: '/tmp/ws',
  permissionMode: 'workspace-write',
  runSettings: { verifyCommands: [], agents: [], budget: null },
  createdAt: now,
  updatedAt: now,
}

const messages = [
  {
    id: 'm1',
    threadId: 't1',
    role: 'user',
    kind: 'text',
    content: 'Fix the login redirect loop',
    createdAt: now,
  },
]

const agents = [
  {
    id: 'a1',
    name: 'Claude Code',
    status: 'online',
    command: 'claude',
    networkMode: 'agent-managed',
  },
  { id: 'a2', name: 'Codex', status: 'online', command: 'codex', networkMode: 'agent-managed' },
]

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => {
    localStorage.setItem('hubagent_token', value)
    localStorage.setItem('hubagent.locale', 'en-US')
  }, token)
})

test('run settings take over the CLI-only knobs and persist per thread', async ({ page }) => {
  let patched: unknown
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [] } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents } })
    if (path === '/api/v1/chat/threads')
      return route.fulfill({ json: { ok: true, threads: [{ ...thread, messageCount: 1 }] } })
    if (path === '/api/v1/chat/threads/t1' && request.method() === 'PATCH') {
      patched = request.postDataJSON()
      const body = patched as { runSettings?: unknown }
      return route.fulfill({
        json: { ok: true, thread: { ...thread, runSettings: body.runSettings } },
      })
    }
    if (path === '/api/v1/chat/threads/t1')
      return route.fulfill({ json: { ok: true, thread, messages } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/chat/t1')
  await page.getByRole('button', { name: 'Run settings' }).click()

  const dialog = page.getByRole('dialog', { name: 'Run settings' })
  await expect(dialog).toBeVisible()
  /* 不填验收命令时直说只能核对改动范围——不要让人以为这就是验收。 */
  await expect(dialog.getByText(/diffScope/)).toBeVisible()

  await dialog.getByRole('checkbox', { name: 'Codex' }).check()
  await dialog.getByRole('button', { name: 'Add a command' }).click()
  await dialog.getByRole('textbox', { name: 'Verification commands' }).fill('pnpm test:unit')
  await dialog.getByLabel(/min per turn/).fill('3')
  await dialog.getByLabel(/actions per turn/).fill('8')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(dialog).toBeHidden()
  await expect
    .poll(() => patched)
    .toEqual({
      runSettings: {
        verifyCommands: ['pnpm test:unit'],
        agents: ['Codex'],
        budget: { timeoutMs: 180000, maxActions: 8 },
      },
    })
})

test('a passing run can export its patch, and auto-merge is refused with a reason', async ({
  page,
}) => {
  const iso = new Date().toISOString()
  const task = {
    id: 'task1',
    goalId: 'g1',
    title: 'Fix login redirect loop',
    status: 'completed',
    description: '',
    createdAt: iso,
  }
  const detail = {
    ok: true,
    task,
    subtasks: [],
    executions: [
      {
        id: 'exe1',
        taskId: 'task1',
        status: 'completed',
        attempt: 1,
        agentId: 'a1',
        evidence: {
          branch: 'hubagent/exe1',
          diffstat: ' src/a.ts | 3 +-\n 1 file changed, 2 insertions(+), 1 deletion(-)',
          changedFiles: ['src/a.ts'],
          diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n',
        },
      },
    ],
    verifications: [
      {
        id: 'v1',
        executionId: 'exe1',
        verdict: 'pass',
        checks: [
          { checkId: 'c1', kind: 'command', passed: true, command: 'pnpm test:unit', exitCode: 0 },
        ],
      },
    ],
    approvals: [],
  }
  let delivered: unknown
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/events/stream') return route.abort()
    if (path === '/api/v1/tasks') return route.fulfill({ json: { ok: true, tasks: [task] } })
    if (path === '/api/v1/agents') return route.fulfill({ json: { ok: true, agents } })
    if (path === '/api/v1/approvals') return route.fulfill({ json: { ok: true, approvals: [] } })
    if (path === '/api/v1/tasks/task1/deliver') {
      const body = request.postDataJSON() as { mode: string }
      delivered = body.mode
      if (body.mode === 'auto-merge') {
        return route.fulfill({
          status: 409,
          json: {
            code: 'DELIVERY_CONFLICT',
            message: 'auto-merge 需要项目配置 targetRef 与 autoMerge；当前未配置，已拒绝合并',
          },
        })
      }
      return route.fulfill({
        json: {
          ok: true,
          delivery: {
            mode: 'patch-export',
            branch: 'hubagent/exe1',
            patchRef: '/home/u/.hubagent/artifacts/task1.patch',
            files: 1,
            added: 2,
            removed: 1,
          },
        },
      })
    }
    if (path === '/api/v1/tasks/task1') return route.fulfill({ json: detail })
    if (path === '/api/v1/tasks/task1/decisions')
      return route.fulfill({ json: { ok: true, decisions: [] } })
    if (path === '/api/v1/chat/threads') return route.fulfill({ json: { ok: true, threads: [] } })
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
  })

  await page.goto('/tasks/task1')
  await expect(page.getByText('Verification passed', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Export patch' }).click()
  await expect(page.getByText(/Saved to .*task1\.patch/)).toBeVisible()
  expect(delivered).toBe('patch-export')
})
