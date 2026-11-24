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

export interface ChatThread {
  id: string
  title: string
  goalId?: string
  taskId?: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface ChatThreadSummary extends ChatThread {
  messageCount: number
  lastMessage?: string
}

export interface ChatMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'plan' | 'task' | 'result' | 'error' | 'approval' | 'clarification'
  content: string
  goalId?: string
  taskId?: string
  approvalId?: string
  clarificationId?: string
  createdAt: string
}

export interface ChatThreadDetail {
  thread: ChatThread
  messages: ChatMessage[]
}

export const chatApi = {
  threads: () => request<{ threads: ChatThreadSummary[] }>('/api/v1/chat/threads'),
  create: (title?: string) =>
    request<{ thread: ChatThread }>('/api/v1/chat/threads', {
      method: 'POST',
      body: JSON.stringify(title === undefined ? {} : { title }),
    }),
  thread: (id: string, options: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.before !== undefined) params.set('before', options.before)
    const query = params.toString()
    return request<ChatThreadDetail & { ok: boolean }>(
      `/api/v1/chat/threads/${id}${query === '' ? '' : `?${query}`}`,
    )
  },
  answer: (id: string, clarificationId: string, answer: string) =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(
      `/api/v1/chat/threads/${id}/clarifications/${clarificationId}/answer`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),
  resume: (id: string) =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(`/api/v1/chat/threads/${id}/resume`, {
      method: 'POST',
    }),
  post: (id: string, text: string, mode: 'run' | 'ask') =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(
      `/api/v1/chat/threads/${id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ text, mode }),
      },
    ),
}
