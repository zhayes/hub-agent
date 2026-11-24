export interface TaskRow {
  id: string
  goalId: string
  title: string
  status: string
  createdAt: string
}

export interface AgentRow {
  id: string
  name: string
  status: string
  command: string
  networkMode: string
  capabilities?: unknown
}

export interface ApprovalRow {
  id: string
  taskId: string
  executionId: string
  reason: string
  resource: string
  status: string
  riskLevel: string
}

export interface TaskView {
  task: { id: string; goalId: string; title: string; status: string; description: string }
  subtasks: Array<{ id: string; title: string; status: string; required: boolean }>
  executions: Array<{
    id: string
    status: string
    attempt: number
    evidence?: {
      branch?: string
      commitSha?: string
      diffstat?: string
      changedFiles?: string[]
      transcriptRef?: string
    }
  }>
  verifications: Array<{
    id: string
    executionId: string
    verdict: string
    checks: Array<{
      checkId: string
      kind: string
      passed: boolean
      command?: string
      exitCode?: number
      outputRef?: string
    }>
  }>
  approvals: ApprovalRow[]
}

export interface Decision {
  id: string
  type: string
  rationale: string
  decidedAt: string
}

export function getToken(): string {
  const injected = (window as Window & { __HUBAGENT_TOKEN__?: string }).__HUBAGENT_TOKEN__
  return injected ?? localStorage.getItem('hubagent_token') ?? ''
}

export function saveToken(token: string): void {
  localStorage.setItem('hubagent_token', token)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status}: ${text}`)
  }
  return (await response.json()) as T
}

export const api = {
  tasks: () => request<{ tasks: TaskRow[] }>('/api/v1/tasks'),
  task: (id: string) => request<TaskView & { ok: boolean }>(`/api/v1/tasks/${id}`),
  decisions: (id: string) => request<{ decisions: Decision[] }>(`/api/v1/tasks/${id}/decisions`),
  agents: () => request<{ agents: AgentRow[] }>('/api/v1/agents'),
  approvals: () => request<{ approvals: ApprovalRow[] }>('/api/v1/approvals'),
  approve: (id: string) => request(`/api/v1/approvals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => request(`/api/v1/approvals/${id}/reject`, { method: 'POST' }),
}
