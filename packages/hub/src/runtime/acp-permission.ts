import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import { PERMISSION_MODES, type PermissionMode } from '../domain/status'

/**
 * ACP 工具调用授权策略（PRD §6.4.5 / 会话三档权限）。
 *
 * 背景：Agent 在跑命令/写文件前会发 `session/request_permission`。此前我们**没有**
 * 任何 handler，代码走"默认拒绝"，于是 Agent 收到 reject 后直接结束回合
 * （`stopReason: cancelled`），被上层记成"执行失败"——明明只是 `ls`。
 *
 * 现在按会话档位作答，语义是**能看不能改 ≠ 什么都干不了**：
 *
 * | 档位 | 只读工具 | 变更工具 | 网络 |
 * |---|---|---|---|
 * | read-only | 允许 | 拒绝 | 拒绝 |
 * | workspace-write | 允许 | 允许（沙箱仍限在 workspace） | 允许 |
 * | full | 允许 | 允许（不再询问） | 允许 |
 *
 * 判不准时**一律按变更处理**（fail-closed）：宁可让 Agent 换条路，也不放行未知命令。
 */

export type ToolCallClass = 'read' | 'mutate' | 'network'

export interface ToolCallAssessment {
  class: ToolCallClass
  /** 给人看的一句话，写进 transcript/失败原因。 */
  summary: string
}

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'find',
  'fd',
  'pwd',
  'echo',
  'printf',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'which',
  'type',
  'id',
  'whoami',
  'groups',
  'date',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'jq',
  'diff',
  'cmp',
  'comm',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'test',
  'true',
  'false',
  'env',
  'printenv',
  'uname',
  'hostname',
  'sw_vers',
  'md5',
  'md5sum',
  'shasum',
  'sha256sum',
  'sha1sum',
  'ps',
  'lsof',
  'netstat',
  'sleep',
  'printf',
])

/** 即使出现在只读命令里也必须拦下的危险形态。 */
const MUTATING_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/,
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bln\s/,
  /\btruncate\b/,
  /\bdd\s/,
  /\btee\b/,
  /\bkdd\b/,
  /\bpkill\b/,
  /\bkill\b/,
  /\bsed\s+(-i|--in-place)/,
  /\bperl\s+-i/,
  /\bdefaults\s+write\b/,
  /\blaunchctl\b/,
  /\bosascript\b/,
  /\bopen\s/,
  /\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall|up|update)\b/,
  /\bpip3?\s+install\b/,
  /\bbrew\s+(install|uninstall|upgrade)\b/,
  /\bgit\s+.*\b(clone|init)\b/,
]

/** git 的只读子命令；其余（commit/push/checkout/…）一律按变更处理。 */
const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'describe',
  'rev-parse',
  'ls-files',
  'shortlog',
  'whatchanged',
  'cat-file',
  'ls-tree',
  'count-objects',
  'grep',
])

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/**
 * 判断一次工具调用属于只读 / 变更 / 网络。
 *
 * `execute` 类命令要靠命令本身判断（`ls` 与 `rm` 都是 execute），
 * 所以这里做的是**保守的白名单 + 危险模式黑名单**：认不出就是变更。
 */
export function assessToolCall(toolCall: ToolCallUpdate): ToolCallAssessment {
  const kind = toolCall.kind
  const command = commandOf(toolCall)

  if (kind === 'read' || kind === 'search' || kind === 'think') {
    return { class: 'read', summary: `只读工具 ${kind}` }
  }
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'switch_mode') {
    return { class: 'mutate', summary: `变更工具 ${kind}` }
  }
  if (kind === 'fetch') {
    return { class: 'network', summary: '网络请求' }
  }

  /* kind 缺省 / execute / other：只能看命令。 */
  if (command === undefined) {
    return { class: 'mutate', summary: `无法判定用途（kind=${kind ?? 'unknown'}）` }
  }
  return assessCommand(command)
}

/** 逐段检查 `&&` / `||` / `;` / `|` 组成的命令链。 */
export function assessCommand(rawCommand: string): ToolCallAssessment {
  const command = rawCommand.trim()
  if (command === '') return { class: 'mutate', summary: '空命令' }

  if (hasFileRedirection(command)) {
    return { class: 'mutate', summary: `含输出重定向：${short(command)}` }
  }
  for (const pattern of MUTATING_PATTERNS) {
    if (pattern.test(command)) {
      return { class: 'mutate', summary: `命中危险模式 ${pattern.source}：${short(command)}` }
    }
  }

  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  if (segments.length === 0) return { class: 'mutate', summary: '空命令' }

  for (const segment of segments) {
    if (!isReadOnlySegment(segment)) {
      return { class: 'mutate', summary: `非只读命令：${short(segment)}` }
    }
  }
  return { class: 'read', summary: `只读命令：${short(command)}` }
}

/**
 * 按档位给出决定。
 *
 * - `full` / `workspace-write`：放行，且优先 `allow_always`，避免同一会话反复弹窗；
 *   真正拦得住越界写的是沙箱，不是这里。
 * - `read-only`：只读放行；变更/网络拒绝。
 */
export function decidePermission(
  mode: PermissionMode,
  toolCall: ToolCallUpdate,
): { allow: boolean; assessment: ToolCallAssessment } {
  const assessment = assessToolCall(toolCall)
  if (mode === 'full' || mode === 'workspace-write') {
    return { allow: true, assessment }
  }
  /* read-only：能看不能改，网络也不放行（避免只读会话往外送数据）。 */
  return { allow: assessment.class === 'read', assessment }
}

/**
 * 把决定转成 ACP 响应。
 *
 * 注意：**拒绝时必须挑 `reject_*` 选项**。若请求里没有 reject 选项而返回
 * `cancelled`，Agent 会直接结束整个回合——这正是之前"问个问题就失败"的形态。
 */
export function toPermissionResponse(
  request: RequestPermissionRequest,
  allow: boolean,
): RequestPermissionResponse {
  const option = pickOption(request.options, allow)
  if (option === undefined) {
    return allow
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: fallbackRejectId(request.options) } }
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

function pickOption(
  options: readonly PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  const preferredKinds = allow
    ? (['allow_always', 'allow_once'] as const)
    : (['reject_once', 'reject_always'] as const)
  for (const kind of preferredKinds) {
    const found = options.find((option) => option.kind === kind)
    if (found !== undefined) return found
  }
  /* 没有完全匹配时退一步：按语义取任意允许/拒绝项。 */
  return options.find((option) =>
    allow
      ? option.kind === 'allow_always' || option.kind === 'allow_once'
      : option.kind === 'reject_once' || option.kind === 'reject_always',
  )
}

function fallbackRejectId(options: readonly PermissionOption[]): string {
  return options[0]?.optionId ?? 'reject'
}

function commandOf(toolCall: ToolCallUpdate): string | undefined {
  const raw = toolCall.rawInput
  if (typeof raw !== 'object' || raw === null) return undefined
  const command = (raw as Record<string, unknown>)['command']
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
}

/** `>` / `>>` 写文件；`2>/dev/null`、`2>&1`、`>&2` 属于噪音，不算。 */
function hasFileRedirection(command: string): boolean {
  const withoutNoise = command.replaceAll(/\d?>\s*\/dev\/null/g, ' ').replaceAll(/\d?>&\d/g, ' ')
  return /(^|[^0-9])>{1,2}(?!&)/.test(withoutNoise)
}

function isReadOnlySegment(segment: string): boolean {
  const argv = segment.split(/\s+/).filter((token) => token !== '')
  const head = argv[0]
  if (head === undefined) return false
  const command = baseName(head)

  if (command === 'git') return isReadOnlyGit(argv.slice(1))
  return READ_ONLY_COMMANDS.has(command)
}

function isReadOnlyGit(args: readonly string[]): boolean {
  /* 跳过 `-C <path>` 这类带值的全局参数，找到真正的子命令。 */
  let index = 0
  while (index < args.length) {
    const token = args[index]
    if (token === undefined) break
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  const subcommand = args[index]
  if (subcommand === undefined) return false
  if (subcommand === 'worktree') {
    const next = args[index + 1]
    return next === 'list'
  }
  if (subcommand === 'branch' || subcommand === 'tag' || subcommand === 'stash') {
    /* `branch -d` / `stash drop` 是变更；只放行不带破坏性参数的形态。 */
    const rest = args.slice(index + 1)
    const destructive = rest.some(
      (token) => token === '-d' || token === '-D' || token === 'drop' || token === 'clear',
    )
    return !destructive
  }
  return GIT_READ_ONLY.has(subcommand)
}

function baseName(command: string): string {
  const normalized = command.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

function short(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`
}

export type { PermissionMode }
export { PERMISSION_MODES }
