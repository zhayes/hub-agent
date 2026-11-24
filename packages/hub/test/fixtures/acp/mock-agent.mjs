#!/usr/bin/env node
/**
 * 测试用 ACP Agent：只实现 M4 需要的基线方法。
 *
 * 它故意把 stdout 只用于 JSON-RPC，日志写 stderr，用来验证分帧与 stderr 分离。
 * 环境变量：
 *   MOCK_ACP_DELAY_MS=300         prompt 回复前等待，便于测 cancel
 *   MOCK_ACP_REQUEST_PERMISSION=1 先发 session/request_permission，再决定是否写文件
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const delayMs = Number(process.env.MOCK_ACP_DELAY_MS ?? '300')
const requestPermission = process.env.MOCK_ACP_REQUEST_PERMISSION === '1'

setTimeout(() => process.stderr.write('[mock-acp] started\n'), 10)

const rl = createInterface({ input: process.stdin })
let sessionId = 'mock-session-1'
let cwd = process.cwd()
let requestSeq = 1000
let cancelled = false
let pendingPrompt = null
let promptTimer = null
let pendingPermission = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function update(updatePayload) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: updatePayload },
  })
}

function finishPrompt(stopReason) {
  if (pendingPrompt === null) return
  if (promptTimer !== null) clearTimeout(promptTimer)
  promptTimer = null
  const id = pendingPrompt
  pendingPrompt = null
  reply(id, { stopReason })
}

function maybeCommit() {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
  })
  if (inside.status !== 0) return
  spawnSync('git', ['add', 'mock-output.txt'], { cwd, encoding: 'utf8' })
  spawnSync(
    'git',
    ['-c', 'user.name=Mock ACP', '-c', 'user.email=mock@local', 'commit', '-m', 'mock change'],
    { cwd, encoding: 'utf8' },
  )
}

async function handlePrompt(id, params) {
  cancelled = false
  pendingPrompt = id
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'mock agent working' },
    messageId: 'msg-1',
  })
  update({
    sessionUpdate: 'plan',
    entries: [{ content: 'write mock-output.txt', priority: 'high', status: 'in_progress' }],
  })
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    title: 'Write mock-output.txt',
    kind: 'edit',
    status: 'in_progress',
  })

  let allowed = true
  if (requestPermission) {
    const permissionId = ++requestSeq
    const response = await new Promise((resolve) => {
      pendingPermission = resolve
      send({
        jsonrpc: '2.0',
        id: permissionId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Write mock-output.txt',
            kind: 'edit',
            status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
    })
    pendingPermission = null
    allowed =
      response?.result?.outcome?.outcome === 'selected' &&
      response.result.outcome.optionId === 'allow-once'
  }

  if (!allowed) {
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'failed',
      title: 'Write mock-output.txt (permission denied)',
    })
    finishPrompt('refusal')
    return
  }

  writeFileSync(
    join(cwd, 'mock-output.txt'),
    `mock output ${new Date().toISOString()} ${params.sessionId}\n`,
    'utf8',
  )
  maybeCommit()
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'completed',
    title: 'Write mock-output.txt',
  })

  if (delayMs > 0) {
    promptTimer = setTimeout(() => finishPrompt(cancelled ? 'cancelled' : 'end_turn'), delayMs)
  } else {
    finishPrompt('end_turn')
  }
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.method === undefined) {
    if (message.id !== undefined && pendingPermission !== null) {
      const resolve = pendingPermission
      pendingPermission = null
      resolve(message)
    }
    return
  }

  switch (message.method) {
    case 'initialize': {
      const response = {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'mock-acp', version: '0.0.0' },
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { close: {} },
          },
        },
      }
      if (process.env.MOCK_ACP_SPLIT === '1') {
        // 故意把一行拆成三段，验证上层行缓冲/粘包处理。
        const text = JSON.stringify(response)
        process.stdout.write(text.slice(0, 17))
        setTimeout(() => process.stdout.write(text.slice(17, 61)), 10)
        setTimeout(() => process.stdout.write(`${text.slice(61)}\n`), 20)
      } else {
        send(response)
      }
      return
    }

    case 'session/new':
      cwd = message.params?.cwd ?? cwd
      sessionId = 'mock-session-1'
      reply(message.id, { sessionId })
      return

    case 'session/prompt':
      void handlePrompt(message.id, message.params ?? {})
      return

    case 'session/cancel':
      cancelled = true
      if (pendingPrompt !== null) finishPrompt('cancelled')
      return

    case 'session/close':
      reply(message.id, {})
      return

    default:
      fail(message.id, -32601, `method not found: ${message.method}`)
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
