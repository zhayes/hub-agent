#!/usr/bin/env node
import { startHub } from '../interfaces/http/server'

/**
 * 兼容入口：`hubagentd` 等价于 `ha web`。
 *
 *   hubagentd           前台常驻（Ctrl-C / SIGTERM 退出并释放锁）
 *   hubagentd --check   起服务后立即释放，用于自检
 */
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const version = process.env['HUBAGENT_VERSION'] ?? '0.0.0-m0'

async function main(): Promise<void> {
  const handle = await startHub({ version })

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      hubDir: handle.home,
      lock: handle.lockPath,
      port: handle.port,
      url: handle.url,
      tokenPath: handle.tokenPath,
      webBuilt: handle.webBuilt,
      recovery: handle.recovery,
    })}\n`,
  )

  if (checkOnly) {
    await handle.close()
    return
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })

  await handle.close()
  process.stdout.write(`${JSON.stringify({ ok: true, stopped: true })}\n`)
}

main().catch((error: unknown) => {
  const payload =
    typeof error === 'object' && error !== null && 'code' in error
      ? ((error as { toJSON?: () => unknown }).toJSON?.() ?? { message: String(error) })
      : { message: String(error) }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
  process.exitCode = 1
})
