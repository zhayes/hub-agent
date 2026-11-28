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
  allowedWrite?: string[]
  catalogId?: string
  variantId?: string
  lastProbeAt?: string
  lastProbeError?: string
}

export interface ScanVariant {
  id: string
  label: string
  command: string
  source: string
  allowedWrite: string[]
  missingRequires: string[]
  adoptable: boolean
}

export interface ScannedAgent {
  catalogId: string
  label: string
  name: string
  notes?: string
  variants: ScanVariant[]
  chosenVariant?: string
  registered: boolean
  agentStatus?: string
}

export interface CatalogScan {
  version: number
  scannedAt: string
  agents: ScannedAgent[]
  problems: Array<{ entryId: string; message: string }>
}

export interface AuthMethodView {
  id: string
  name?: string
  description?: string | null
  type?: 'agent' | 'terminal'
}

export interface ProbeResultView {
  ok: boolean
  status: 'online' | 'needs_auth' | 'error'
  durationMs: number
  authMethods: AuthMethodView[]
  stderrTail: string[]
  protocolVersion?: number
  capabilities?: unknown
  error?: { code: string; message: string }
}

export interface ApprovalRow {
  id: string
  taskId: string
  executionId: string
  reason: string
  resource: string
  status: string
  riskLevel: string
  /** 领域动作名，如 `sandbox.relax`：决定标题怎么说。 */
  action?: string
  /** once = 仅本次；policy = 按策略长期生效 */
  decisionMode?: 'once' | 'policy'
  /** 过期时间（ISO）；`once` 审批有 TTL。 */
  expiresAt?: string
  createdAt?: string
  requestedBy?: string
}

export interface TaskView {
  task: { id: string; goalId: string; title: string; status: string; description: string }
  subtasks: Array<{
    id: string
    title: string
    status: string
    required: boolean
    /** 已分派的 Agent；未分派时缺省。后端一直有，只是这里以前没声明。 */
    assignedAgentId?: string
  }>
  executions: Array<{
    id: string
    status: string
    attempt: number
    /** 谁跑的这一次尝试。 */
    agentId?: string
    subtaskId?: string
    /** 失败归因：协议 / Agent 自身 / 资源 / 验收未过 / 预算用尽。 */
    failureCategory?: 'protocol' | 'agent' | 'resource' | 'verification' | 'budget'
    createdAt?: string
    startedAt?: string
    finishedAt?: string
    evidence?: {
      branch?: string
      commitSha?: string
      diffstat?: string
      changedFiles?: string[]
      transcriptRef?: string
      diff?: string
      diffTruncated?: boolean
    }
  }>
  verifications: Array<{
    id: string
    executionId: string
    verdict: string
    createdAt?: string
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
    /* 后端错误体是 {code,message}：直接把它展示给用户，别露出 `500: {"code":...}`。 */
    let message = text
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message !== '') message = parsed.message
    } catch {
      // 非 JSON 错误体保持原文
    }
    throw new Error(message === '' ? `请求失败（HTTP ${response.status}）` : message)
  }
  /* A dev server answers unknown /api routes with index.html, which used to
     surface as `Unexpected token '<'`. Name the real problem instead. */
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    const preview = (await response.text().catch(() => '')).slice(0, 80)
    throw new Error(
      `${response.status}: expected JSON from ${path}, got ${contentType || 'no content-type'}${
        preview === '' ? '' : ` — ${preview}`
      }`,
    )
  }
  return (await response.json()) as T
}

export const api = {
  tasks: () => request<{ tasks: TaskRow[] }>('/api/v1/tasks'),
  task: (id: string) => request<TaskView & { ok: boolean }>(`/api/v1/tasks/${id}`),
  taskFile: (taskId: string, path: string) =>
    request<{
      ok: true
      file: { path: string; content: string; truncated: boolean; source: 'worktree' | 'project' }
    }>(`/api/v1/tasks/${taskId}/file?path=${encodeURIComponent(path)}`),
  decisions: (id: string) => request<{ decisions: Decision[] }>(`/api/v1/tasks/${id}/decisions`),
  agents: () => request<{ agents: AgentRow[] }>('/api/v1/agents'),
  presence: () => request<AgentPresenceResponse>('/api/v1/agents/presence'),
  scanAgents: () =>
    request<{ ok: boolean } & CatalogScan>('/api/v1/agents/scan', { method: 'POST' }),
  adoptAgent: (catalogId: string, variantId?: string) =>
    request<{ ok: boolean; agent: AgentRow; probe: ProbeResultView }>('/api/v1/agents/adopt', {
      method: 'POST',
      body: JSON.stringify(variantId === undefined ? { catalogId } : { catalogId, variantId }),
    }),
  verifyAgent: (name: string) =>
    request<{ ok: boolean; agent: AgentRow; probe: ProbeResultView }>(
      `/api/v1/agents/${encodeURIComponent(name)}/verify`,
      { method: 'POST' },
    ),
  loginAgent: (name: string, methodId: string) =>
    request<{ ok: boolean; result: { ok: boolean; error?: { message: string } } }>(
      `/api/v1/agents/${encodeURIComponent(name)}/authenticate`,
      { method: 'POST', body: JSON.stringify({ methodId }) },
    ),
  removeAgent: (name: string) =>
    request<{ ok: boolean }>(`/api/v1/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  setAgentStatus: (name: string, status: 'disabled' | 'discovered') =>
    request<{ ok: boolean; agent: AgentRow }>(`/api/v1/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  approvals: () => request<{ approvals: ApprovalRow[] }>('/api/v1/approvals'),
  approve: (id: string) => request(`/api/v1/approvals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => request(`/api/v1/approvals/${id}/reject`, { method: 'POST' }),
  /** 交付（PRD §6.12.4）：用户显式选一次交付方式。 */
  deliverTask: (id: string, mode: DeliveryMode) =>
    request<{ ok: true; delivery: DeliveryResult }>(`/api/v1/tasks/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
}

export interface ModelConfigView {
  agentDir: string
  providerId?: string
  providerName?: string
  modelId?: string
  modelName?: string
  baseUrl?: string
  api?: string
  apiKeySet: boolean
  apiKeyKind: 'literal' | 'env' | 'command' | 'none'
  /** 只给字面量 key 的后 4 位 */
  apiKeyHint?: string
  contextWindow?: number
  maxTokens?: number
  thinkingLevel?: string
}

export interface ProviderSummary {
  providerId: string
  name?: string
  modelId?: string
  modelIds: string[]
  api?: string
  baseUrl?: string
  apiKeySet: boolean
  apiKeyKind: 'literal' | 'env' | 'command' | 'none'
  apiKeyHint?: string
  contextWindow?: number
  maxTokens?: number
  thinkingLevel?: string
  isDefault: boolean
}

export interface ModelConfigPatch {
  providerId: string
  modelId: string
  providerName?: string
  baseUrl?: string
  api?: string
  /** 不传则保留旧 key；传空字符串则删除 */
  apiKey?: string
  contextWindow?: number | null
  maxTokens?: number | null
  thinkingLevel?: string | null
  makeDefault?: boolean
}

export interface ModelSettings {
  model: ModelConfigView
  providers: ProviderSummary[]
}

export const settingsApi = {
  model: () => request<ModelSettings & { ok: boolean }>('/api/v1/settings/model'),
  saveModel: (patch: ModelConfigPatch) =>
    request<ModelSettings & { ok: boolean }>('/api/v1/settings/model', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteProvider: (providerId: string) =>
    request<ModelSettings & { ok: boolean }>(
      `/api/v1/settings/model/providers/${encodeURIComponent(providerId)}`,
      { method: 'DELETE' },
    ),
}

export interface ChatThread {
  id: string
  title: string
  goalId?: string
  taskId?: string
  status: string
  /** 会话工作区（daemon 上的绝对路径）；缺失表示不可执行。 */
  worktree?: string
  permissionMode: PermissionMode
  /** 运行设置：验收命令 / 可用 Agent / 预算（ADR 0029 §2.4）。 */
  runSettings?: ChatRunSettings
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

/** 与后端 `domain/chat.ts` 的 ChatRunSettings 同构。 */
export interface ChatRunSettings {
  /** 验收命令：退出码 0 为通过。空 = 只有默认的 diffScope。 */
  verifyCommands: string[]
  /** 允许参与运行的 Agent 名称；空 = 全部。 */
  agents: string[]
}

export const DEFAULT_RUN_SETTINGS: ChatRunSettings = {
  verifyCommands: [],
  agents: [],
}

/** 交付方式（PRD §6.12.4）。同一次运行可以选一次。 */
export type DeliveryMode = 'branch-only' | 'patch-export'

export interface DeliveryResult {
  mode: DeliveryMode
  branch?: string
  commitSha?: string
  patchRef?: string
  files: number
  added: number
  removed: number
}

/** 会话权限档；语义与后端 `PERMISSION_MODES` 一致。 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'full'

export interface ChatThreadSummary extends ChatThread {
  messageCount: number
  lastMessage?: string
}

export interface ChatMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system'
  kind:
    | 'text'
    | 'plan'
    | 'task'
    | 'result'
    | 'error'
    | 'approval'
    | 'clarification'
    | 'progress'
    | 'auth'
  content: string
  goalId?: string
  taskId?: string
  approvalId?: string
  clarificationId?: string
  agentName?: string
  stage?:
    | 'thinking'
    | 'planned'
    | 'dispatching'
    | 'retrying'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'tool'
    | 'thought'
    | 'output'
  detail?: string
  updatedAt?: string
  createdAt: string
}

export interface ChatThreadDetail {
  thread: ChatThread
  messages: ChatMessage[]
}

export interface ClarificationView {
  id: string
  goalId: string
  kind: 'clarify' | 'decide'
  question: string
  options: string[]
  status: 'pending' | 'answered' | 'expired'
  answer?: string
}

export const chatApi = {
  threads: () => request<{ threads: ChatThreadSummary[] }>('/api/v1/chat/threads'),
  /** 新建会话**必须**带工作区（产品规则）。 */
  create: (input: { worktree: string; title?: string; permissionMode?: PermissionMode }) =>
    request<{ thread: ChatThread }>('/api/v1/chat/threads', {
      method: 'POST',
      body: JSON.stringify({
        worktree: input.worktree,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      }),
    }),
  /** 弹系统目录选择框（daemon 侧）；不收路径参数。 */
  pickDirectory: () =>
    request<{ ok: boolean; path?: string; cancelled?: boolean }>('/api/v1/fs/pick-directory', {
      method: 'POST',
      body: '{}',
    }),
  setPermission: (id: string, permissionMode: PermissionMode) =>
    request<{ thread: ChatThread }>(`/api/v1/chat/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissionMode }),
    }),
  setWorkspace: (id: string, worktree: string) =>
    request<{ thread: ChatThread }>(`/api/v1/chat/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ worktree }),
    }),
  setRunSettings: (id: string, runSettings: ChatRunSettings) =>
    request<{ thread: ChatThread }>(`/api/v1/chat/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ runSettings }),
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
  resume: (id: string, agentName?: string) =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(`/api/v1/chat/threads/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify(agentName === undefined ? {} : { agentName }),
    }),
  rename: (id: string, title: string) =>
    request<{ thread: ChatThread }>(`/api/v1/chat/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  archive: (id: string) =>
    request<{ thread: ChatThread }>(`/api/v1/chat/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/chat/threads/${id}`, { method: 'DELETE' }),
  post: (id: string, text: string) =>
    request<{ thread: ChatThread; messages: ChatMessage[] }>(
      `/api/v1/chat/threads/${id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ text }),
      },
    ),
  clarification: (id: string) =>
    request<{ clarification: ClarificationView }>(`/api/v1/clarifications/${id}`),
}

/* --- Agent presence (PLAN-AGENT-OFFICE §3.1) ------------------------------- */

export type PresenceState =
  | 'discovered'
  | 'starting'
  | 'initializing'
  | 'online'
  | 'busy'
  | 'degraded'
  | 'offline'
  | 'error'
  | 'disabled'

export interface AgentActivity {
  executionId: string
  executionStatus: string
  taskId: string
  taskTitle: string
  subtaskId: string
  subtaskTitle: string
  step?: number
  steps?: number
  attempt: number
  startedAt?: string
  waitingOn: 'permission' | 'input' | null
}

export interface AgentApprovalSummary {
  id: string
  resource: string
  riskLevel: string
  requestedAt: string
}

export interface AgentLastEvent {
  type: string
  at: string
}

export interface AgentPresence {
  id: string
  name: string
  status: string
  presence: PresenceState
  lastSeenAt?: string
  networkMode: string
  allowedWrite: string[]
  allowedDomains: string[]
  capabilities: string[]
  activity?: AgentActivity
  parallelCount: number
  pendingApprovals: AgentApprovalSummary[]
  lastEvent?: AgentLastEvent
}

export interface AgentPresenceResponse {
  ok: boolean
  asOf: string
  agents: AgentPresence[]
}
