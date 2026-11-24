import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHost } from '../../src/agent-host/agent-host'
import { createSrtProvider } from '../../src/sandbox/srt-driver'

/**
 * 真实链路冒烟（不进单测）：
 *   createSrtProvider() → AgentHost.spawn() → srt shell 包装 →
 *   发一行 JSON-RPC → 收一行 → cancel 进程组。
 *
 * 运行：pnpm test:srt-acp
 * 前置：srt 依赖就绪（pnpm hubagent doctor）；不能在嵌套 sandbox-exec 的
 * 环境里跑（见 PLAN M3 的实现备注）。
 */

const TIMEOUT_MS = 15_000

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'hubagent-srt-acp-'))
  const harness = join(cwd, 'harness.mjs')
  writeFileSync(
    harness,
    `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n')
})
setInterval(() => {}, 1000)
`,
    'utf8',
  )

  const provider = createSrtProvider()
  const description = provider.describe()
  console.log('describe:', description)
  if (!description.ready) {
    throw new Error(`沙箱未就绪：${description.detail}`)
  }

  const host = new AgentHost({
    provider,
    timeouts: {
      startupMs: TIMEOUT_MS,
      idleMs: TIMEOUT_MS,
      totalMs: TIMEOUT_MS * 2,
      killGraceMs: 1_000,
    },
  })

  try {
    const agentProcess = await host.spawn('srt-acp-smoke', {
      worktree: cwd,
      command: `${process.execPath} ${harness}`,
      sandbox: { allowedWrite: [] },
    })

    const lines: string[] = []
    agentProcess.onEvent((event) => {
      if (event.type === 'stdout') lines.push(event.line)
    })

    agentProcess.writeLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    )

    const started = Date.now()
    while (lines.length === 0 && Date.now() - started < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    console.log('received:', lines[0] ?? '<none>')
    const exit = await agentProcess.cancel()
    console.log('exit:', {
      reason: exit.reason,
      code: exit.code,
      signal: exit.signal,
      stdout: exit.stdout.trim(),
      stderr: exit.stderr.slice(0, 500),
    })

    if (lines.length === 0) throw new Error('没有收到 JSON-RPC 响应')
    if (exit.reason !== 'canceled') throw new Error(`取消未生效：${exit.reason}`)

    // 边界：worktree 之外的写必须被 srt 拒绝，且文件不能出现。
    const escapePath = join(tmpdir(), `hubagent-srt-escape-${process.pid}-${Date.now()}.txt`)
    const deniedProcess = await host.spawn('srt-deny', {
      worktree: cwd,
      command: `printf escaped > ${escapePath}`,
      sandbox: { allowedWrite: [] },
    })
    const deniedExit = await deniedProcess.wait()
    console.log('deny probe:', {
      code: deniedExit.code,
      stderr: deniedExit.stderr.trim().slice(0, 300),
    })
    if (deniedExit.code === 0) throw new Error('越界写没有被拦截')
    if (existsSync(escapePath)) {
      rmSync(escapePath, { force: true })
      throw new Error('越界文件出现了，沙箱边界失效')
    }
    console.log('PASS: 越界写被拒绝')
  } finally {
    await host.dispose()
    await provider.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }

  console.log('PASS: srt + AgentHost ACP stdio 往返')
}

await main()
