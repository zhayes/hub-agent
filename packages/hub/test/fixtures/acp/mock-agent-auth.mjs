#!/usr/bin/env node
/**
 * 测试用 ACP Agent：initialize 成功但 session/new 要求登录。
 * 用来覆盖接入状态机里的 needs_auth（而不是 error）。
 */
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [
          { id: 'oauth', name: 'Sign in with OAuth', description: 'browser' },
          { id: 'token', name: 'Paste a token', description: null },
          { id: 'tui', name: 'Interactive terminal', type: 'terminal' },
        ],
      },
    })
    return
  }
  if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: 'Authentication required', data: { category: 'auth' } },
    })
    return
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
