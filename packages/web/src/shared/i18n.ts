export type Locale = 'en-US' | 'zh-CN'

const en = {
  appName: 'HubAgent',
  appSubtitle: 'Local multi-agent console',
  primaryNavigation: 'Primary navigation',
  navChat: 'Chat',
  navTasks: 'Tasks',
  navAgents: 'Agents',
  navApprovals: 'Approvals',
  navSettings: 'Settings',
  chat: 'Chat',
  tasks: 'Tasks',
  agents: 'Agents',
  approvals: 'Approvals',
  settings: 'Settings',
  refresh: 'Refresh',
  live: 'Live',
  offline: 'Offline',
  eventStream: 'Event stream',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  eventsCount: '{count} events',
  screenApprovals: '{count} waiting for approval',
  screenRunning: '{count} running',
  screenFailed: '{count} failed',
  screenRegistered: '{count} registered',
  screenNoNetwork: '{count} without network',
  screenWaitingOnYou: '{count} waiting on you',
  pendingCount: '{count} pending',
  stepPlan: 'Plan',
  stepExecute: 'Execute',
  stepVerify: 'Verify',
  stepDecide: 'Decide',
  needsYou: 'Needs your approval',
  threads: 'Threads',
  queue: 'Queue',
  pendingItems: 'Pending',
  you: 'You',
  risk: 'Risk',
  tokenStored: 'Token stored on this device',
  tokenMissing: 'No token yet. Connect the daemon to start.',
  stepSubtasks: 'Subtasks {count}',
  stepRuns: 'Runs {count}',
  stepChecks: 'Checks {count}',
  stepDecisions: 'Decisions {count}',
  apiToken: 'API token',
  apiTokenHint: 'Paste the bearer token from $HUBAGENT_HOME/token',
  save: 'Save',
  noTasks: 'No tasks yet.',
  noAgents: 'No agents registered.',
  noApprovals: 'No pending approvals.',
  selectTask: 'Select a task to inspect evidence and decisions.',
  subtasks: 'Subtasks',
  executions: 'Executions & evidence',
  verification: 'Verification',
  decisions: 'Decisions',
  approvalItems: 'Approvals',
  approvalNeeded: 'Approval needed',
  approve: 'Approve',
  reject: 'Reject',
  network: 'Network',
  command: 'Command',
  palettePlaceholder: 'Type a command…',
  paletteEmpty: 'No matching command.',
  paletteMore: 'More',
  copy: 'Copy',
  patchLimit: 'Limit reached — more not loaded',
  capabilities: 'Capabilities',
  attempt: 'Attempt {count}',
  noBranch: 'no branch',
  noDiffstat: 'No diffstat',
  noSubtasks: 'No subtasks yet.',
  noEvidence: 'No evidence yet.',
  noDecisions: 'No decisions yet.',
  noApprovalsForTask: 'No approvals for this task.',
  taskId: 'Task ID',
  agent: 'Agent',
  status: 'Status',
  theme: 'Theme',
  language: 'Language',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeSystemLabel: 'Theme: system',
  themeLightLabel: 'Theme: light',
  themeDarkLabel: 'Theme: dark',
  languageEnglish: 'English',
  languageChinese: '中文',
  languageLabel: 'Language: {language}',
  themeMenu: 'Theme',
  newThread: 'New thread',
  searchThreads: 'Search threads…',
  noThreads: 'No threads yet.',
  selectThread: 'Select a thread, or start a new one.',
  chatPlaceholder: 'Describe a task, or ask what is happening…',
  chatAskPlaceholder: 'Ask about status, evidence, or a decision…',
  loadOlder: 'Load older messages',
  answer: 'Answer',
  submit: 'Submit',
  clarification: 'Clarification',
  send: 'Send',
  run: 'Run',
  ask: 'Ask',
  runTask: 'Run task',
  askStatus: 'Ask about status',
  messages: 'Messages',
  threadContext: 'Thread context',
  collapseThreads: 'Collapse threads',
  expandThreads: 'Expand threads',
  collapseContext: 'Collapse context',
  expandContext: 'Expand context',
  openThread: 'Open thread',
  statusRunning: 'running',
  statusWaiting: 'waiting',
  statusPaused: 'paused',
  statusCompleted: 'completed',
  statusFailed: 'failed',
  statusReady: 'ready',
  statusQueued: 'queued',
  statusDraft: 'draft',
  statusPending: 'pending',
  statusIdle: 'idle',
  statusOffline: 'offline',
  statusActive: 'active',
  statusPass: 'passed',
  statusFail: 'not passed',
  statusBlocked: 'blocked',
  statusWaitingOnYou: 'waiting on you',
  statusWaitingInput: 'waiting for input',
  statusCancelled: 'cancelled',
  unknown: 'unknown',
  errorPrefix: 'Error',
  copyTaskId: 'Copy task ID',
  openTask: 'Open task',
  loadMore: 'Load more',
  loading: 'Loading…',
  hide: 'Hide',
  show: 'Show',
  tokenRequired: 'API token required',
  openSettings: 'Open settings',
  settingsTitle: 'Settings',
  settingsAppearance: 'Appearance',
  settingsLanguage: 'Language',
  settingsConnection: 'Connection',
  settingsToken: 'Bearer token',
  settingsSaved: 'Saved.',
  settingsModel: 'Model',
  modelAddProvider: 'Add provider',
  modelEdit: 'Edit',
  modelConfigure: 'Configure',
  modelDelete: 'Delete',
  modelCustom: 'Custom',
  modelDefault: 'Default',
  modelName: 'Name',
  modelProvider: 'Provider ID',
  modelModelId: 'Model ID',
  modelBaseUrl: 'Base URL',
  modelApi: 'API',
  modelApiKey: 'API Key',
  modelApiKeySet: 'Key stored',
  modelApiKeyUnset: 'No key yet',
  modelApiKeyHint: 'Leave blank to keep the current key.',
  modelClearKey: 'Clear key',
  showSecret: 'Show key',
  hideSecret: 'Hide key',
  modelContextWindow: 'Context window',
  modelMaxTokens: 'Max tokens',
  modelThinking: 'Thinking',
  modelThinkingDefault: 'Model default',
  modelPreset: 'Preset',
  modelRequired: 'Fill in the required fields.',
  modelSaveFailed: 'Could not save the settings.',
  modelDeleteTitle: 'Delete provider',
  modelDeleteBody: 'The key and model settings for {name} are removed.',
  modelDeleteFailed: 'Could not delete the provider.',
  cancel: 'Cancel',
  close: 'Close',
  evidence: 'Evidence',
  plan: 'Plan',
  execution: 'Execution',
  result: 'Result',
  approval: 'Approval',
  commandExit: 'exit {code}',
  duration: '{value}',
} as const

export type MessageKey = keyof typeof en
export type Translator = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string

const zh: Record<MessageKey, string> = {
  appName: 'HubAgent',
  appSubtitle: '本地多 Agent 控制台',
  primaryNavigation: '主导航',
  navChat: '对话',
  navTasks: '任务',
  navAgents: 'Agent',
  navApprovals: '审批',
  navSettings: '设置',
  chat: '对话',
  tasks: '任务',
  agents: 'Agent',
  approvals: '审批',
  settings: '设置',
  refresh: '刷新',
  live: '实时',
  offline: '离线',
  eventStream: '事件流',
  connected: '已连接',
  reconnecting: '重连中',
  eventsCount: '{count} 条事件',
  screenApprovals: '{count} 项待审批',
  screenRunning: '{count} 个运行中',
  screenFailed: '{count} 个失败',
  screenRegistered: '已注册 {count} 个',
  screenNoNetwork: '{count} 个无网络权限',
  screenWaitingOnYou: '{count} 项等你处理',
  pendingCount: '{count} 项待处理',
  stepPlan: '计划',
  stepExecute: '执行',
  stepVerify: '验收',
  stepDecide: '决策',
  needsYou: '需要你审批',
  threads: '对话',
  queue: '队列',
  pendingItems: '待处理',
  you: '你',
  risk: '风险',
  tokenStored: 'Token 已保存在本机',
  tokenMissing: '尚未配置 Token，先连接本地守护进程',
  stepSubtasks: '子任务 {count}',
  stepRuns: '执行 {count}',
  stepChecks: '检查 {count}',
  stepDecisions: '决策 {count}',
  apiToken: 'API Token',
  apiTokenHint: '粘贴 $HUBAGENT_HOME/token 中的 bearer token',
  save: '保存',
  noTasks: '暂无任务。',
  noAgents: '暂无已注册 Agent。',
  noApprovals: '暂无待审批项。',
  selectTask: '选择一个任务查看证据和决策。',
  subtasks: '子任务',
  executions: '执行与证据',
  verification: '验收',
  decisions: '决策',
  approvalItems: '审批',
  approvalNeeded: '需要审批',
  approve: '批准',
  reject: '拒绝',
  network: '网络',
  command: '命令',
  palettePlaceholder: '输入命令',
  paletteEmpty: '无结果',
  paletteMore: '更多',
  copy: '复制',
  patchLimit: '已过限制，未加载更多',
  capabilities: '能力',
  attempt: '第 {count} 次',
  noBranch: '无分支',
  noDiffstat: '无 diffstat',
  noSubtasks: '暂无子任务。',
  noEvidence: '暂无证据。',
  noDecisions: '暂无决策。',
  noApprovalsForTask: '此任务暂无审批。',
  taskId: '任务 ID',
  agent: 'Agent',
  status: '状态',
  theme: '主题',
  language: '语言',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  themeSystemLabel: '主题：跟随系统',
  themeLightLabel: '主题：浅色',
  themeDarkLabel: '主题：深色',
  languageEnglish: 'English',
  languageChinese: '中文',
  languageLabel: '语言：{language}',
  themeMenu: '主题',
  newThread: '新建对话',
  searchThreads: '搜索对话…',
  noThreads: '暂无对话。',
  selectThread: '选择一个对话，或新建一个。',
  chatPlaceholder: '描述任务，或问“现在怎么样”…',
  chatAskPlaceholder: '问状态、证据或某个决策…',
  loadOlder: '加载更早消息',
  answer: '回答',
  submit: '提交',
  clarification: '需要澄清',
  send: '发送',
  run: '运行',
  ask: '询问',
  runTask: '运行任务',
  askStatus: '询问状态',
  messages: '消息',
  threadContext: '对话上下文',
  collapseThreads: '收起对话栏',
  expandThreads: '展开对话栏',
  collapseContext: '收起上下文栏',
  expandContext: '展开上下文栏',
  openThread: '打开对话',
  statusRunning: '运行中',
  statusWaiting: '等待中',
  statusPaused: '已暂停',
  statusCompleted: '已完成',
  statusFailed: '失败',
  statusReady: '待执行',
  statusQueued: '排队中',
  statusDraft: '草稿',
  statusPending: '待处理',
  statusIdle: '空闲',
  statusOffline: '离线',
  statusActive: '进行中',
  statusPass: '已通过',
  statusFail: '未通过',
  statusBlocked: '受阻',
  statusWaitingOnYou: '待你审批',
  statusWaitingInput: '等待输入',
  statusCancelled: '已取消',
  unknown: '未知',
  errorPrefix: '错误',
  copyTaskId: '复制任务 ID',
  openTask: '打开任务',
  loadMore: '加载更多',
  loading: '加载中…',
  hide: '收起',
  show: '展开',
  tokenRequired: '需要 API Token',
  openSettings: '打开设置',
  settingsTitle: '设置',
  settingsAppearance: '外观',
  settingsLanguage: '语言',
  settingsConnection: '连接',
  settingsToken: 'Bearer Token',
  settingsSaved: '已保存。',
  settingsModel: '模型',
  modelAddProvider: '添加模型提供商',
  modelEdit: '编辑',
  modelConfigure: '配置',
  modelDelete: '删除',
  modelCustom: '自定义',
  modelDefault: '默认',
  modelName: '名称',
  modelProvider: '标识',
  modelModelId: 'Model ID',
  modelBaseUrl: 'Base URL',
  modelApi: 'API',
  modelApiKey: 'API Key',
  modelApiKeySet: '已配置',
  modelApiKeyUnset: '未配置',
  modelApiKeyHint: '已配置，留空则不变',
  modelClearKey: '清除密钥',
  showSecret: '显示密钥',
  hideSecret: '隐藏密钥',
  modelContextWindow: '上下文',
  modelMaxTokens: '最大 Tokens',
  modelThinking: '思考',
  modelThinkingDefault: '模型默认',
  modelPreset: '预设',
  modelRequired: '请填写必填项。',
  modelSaveFailed: '保存失败',
  modelDeleteTitle: '删除提供商',
  modelDeleteBody: '将移除 {name} 的密钥与模型配置。',
  modelDeleteFailed: '删除失败',
  cancel: '取消',
  close: '关闭',
  evidence: '证据',
  plan: '计划',
  execution: '执行',
  result: '结果',
  approval: '审批',
  commandExit: '退出码 {code}',
  duration: '{value}',
}

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'en-US': en,
  'zh-CN': zh,
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en-US' || value === 'zh-CN'
}

export function detectLocale(languages: readonly string[] = []): Locale {
  for (const language of languages) {
    if (language.toLowerCase().startsWith('zh')) return 'zh-CN'
    if (language.toLowerCase().startsWith('en')) return 'en-US'
  }
  return 'en-US'
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const template = dictionaries[locale][key] ?? dictionaries['en-US'][key] ?? key
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

export function statusKey(status: string): MessageKey {
  switch (status) {
    case 'running':
      return 'statusRunning'
    case 'waiting_approval':
      return 'statusWaitingOnYou'
    case 'waiting_input':
      return 'statusWaitingInput'
    case 'waiting':
      return 'statusWaiting'
    case 'paused':
      return 'statusPaused'
    case 'completed':
    case 'succeeded':
      return 'statusCompleted'
    case 'failed':
    case 'error':
      return 'statusFailed'
    case 'ready':
      return 'statusReady'
    case 'queued':
      return 'statusQueued'
    case 'draft':
      return 'statusDraft'
    case 'pending':
      return 'statusPending'
    case 'idle':
      return 'statusIdle'
    case 'offline':
      return 'statusOffline'
    case 'active':
      return 'statusActive'
    case 'pass':
    case 'passed':
    case 'verified':
      return 'statusPass'
    case 'fail':
      return 'statusFail'
    case 'blocked':
      return 'statusBlocked'
    case 'cancelled':
    case 'canceled':
      return 'statusCancelled'
    default:
      return 'unknown'
  }
}

export function formatDateTime(locale: Locale, iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatRelativeTime(locale: Locale, iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(deltaSeconds)
  if (abs < 60) return formatter.format(deltaSeconds, 'second')
  if (abs < 3600) return formatter.format(Math.round(deltaSeconds / 60), 'minute')
  if (abs < 86_400) return formatter.format(Math.round(deltaSeconds / 3600), 'hour')
  return formatter.format(Math.round(deltaSeconds / 86_400), 'day')
}

export const messageKeys = Object.keys(en) as MessageKey[]
