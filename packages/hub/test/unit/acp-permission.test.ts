import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  assessCommand,
  assessToolCall,
  decidePermission,
  toPermissionResponse,
} from '../../src/runtime/acp-permission'

function call(kind: ToolCallUpdate['kind'], command?: string): ToolCallUpdate {
  return {
    toolCallId: 'call-1',
    ...(kind === undefined ? {} : { kind }),
    ...(command === undefined ? {} : { rawInput: { command } }),
  }
}

describe('工具调用分类', () => {
  it('显式只读类工具直接放行', () => {
    for (const kind of ['read', 'search', 'think'] as const) {
      expect(assessToolCall(call(kind)).class).toBe('read')
    }
  })

  it('显式变更类工具一律按变更处理', () => {
    for (const kind of ['edit', 'delete', 'move', 'switch_mode'] as const) {
      expect(assessToolCall(call(kind)).class).toBe('mutate')
    }
  })

  it('fetch 归为网络', () => {
    expect(assessToolCall(call('fetch')).class).toBe('network')
  })

  it('认不出用途时按变更处理（fail-closed）', () => {
    expect(assessToolCall(call('other')).class).toBe('mutate')
    expect(assessToolCall({ toolCallId: 'x' }).class).toBe('mutate')
  })

  it('execute 靠命令本身判断：只读命令放行', () => {
    const readOnly = [
      'ls /Users/chad/hub-agent',
      'ls -la .',
      'cat README.md',
      'grep -rn "foo" src',
      'rg TODO',
      'find . -name "*.ts"',
      'pwd',
      'git status',
      'git log --oneline -5',
      'git -C /Users/chad/hub-agent worktree list',
      'git -C . diff --stat',
      'git branch --show-current',
      'ls /tmp && git status',
      'ls packages | head -20',
      'ls nope 2>/dev/null',
      'echo hi 2>&1',
      'wc -l file.txt',
      'jq . package.json',
    ]
    for (const command of readOnly) {
      expect(assessCommand(command).class, command).toBe('read')
    }
  })

  it('execute 里的写操作一律拦下', () => {
    const mutating = [
      'rm -rf build',
      'mv a b',
      'cp a b',
      'touch x',
      'mkdir -p out',
      'echo hi > out.txt',
      'cat a >> b',
      'sed -i "s/a/b/" f',
      'npm install',
      'pnpm add zod',
      'brew install jq',
      'git commit -m x',
      'git push',
      'git checkout main',
      'git branch -D feature',
      'git stash drop',
      'chmod +x run.sh',
      'sudo ls',
      'curl -s https://example.com',
      "node -e \"require('fs').writeFileSync('a','b')\"",
      'ls && rm -rf /',
    ]
    for (const command of mutating) {
      expect(assessCommand(command).class, command).toBe('mutate')
    }
  })
})

describe('按档位决定', () => {
  const lsCommand = call('execute', 'ls -la')
  const rmCommand = call('execute', 'rm -rf build')
  const fetchCall = call('fetch')

  it('read-only：只允许只读，变更与网络都拒', () => {
    expect(decidePermission('read-only', lsCommand).allow).toBe(true)
    expect(decidePermission('read-only', rmCommand).allow).toBe(false)
    expect(decidePermission('read-only', fetchCall).allow).toBe(false)
    expect(decidePermission('read-only', call('edit')).allow).toBe(false)
  })

  it('workspace-write / full：全部放行（边界由沙箱负责）', () => {
    for (const mode of ['workspace-write', 'full'] as const) {
      expect(decidePermission(mode, lsCommand).allow, mode).toBe(true)
      expect(decidePermission(mode, rmCommand).allow, mode).toBe(true)
      expect(decidePermission(mode, fetchCall).allow, mode).toBe(true)
      expect(decidePermission(mode, call('edit')).allow, mode).toBe(true)
    }
  })
})

describe('转成 ACP 响应', () => {
  const options: PermissionOption[] = [
    { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]

  function request(withOptions: PermissionOption[] = options): RequestPermissionRequest {
    return {
      sessionId: 's1',
      toolCall: call('execute', 'ls'),
      options: withOptions,
    }
  }

  it('允许时优先 allow_always（同一会话不再反复问）', () => {
    expect(toPermissionResponse(request(), true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    })
  })

  it('拒绝时挑选 reject 选项，而不是 cancelled', () => {
    /* 关键：返回 cancelled 会让 Agent 直接结束回合——正是之前“问个问题就失败”的形态。 */
    expect(toPermissionResponse(request(), false)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    })
  })

  it('只有 allow_once 时退而求其次', () => {
    const onlyOnce: PermissionOption[] = [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' },
    ]
    expect(toPermissionResponse(request(onlyOnce), true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    })
  })

  it('没有任何选项时：允许返回 cancelled，拒绝用兜底 id', () => {
    expect(toPermissionResponse(request([]), true)).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(toPermissionResponse(request([]), false)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    })
  })
})
