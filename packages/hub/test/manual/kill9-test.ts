import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { integrityCheck, openDatabase, pragmaValue } from '../../src/storage/db'
import { loadState } from '../../src/storage/queries/state'
import { appliedSeq, replayAll } from '../../src/storage/rebuild'
import { eventCount, lastSeq } from '../../src/storage/write/events'

/**
 * M2 门禁：`kill -9` 之后重启，状态必须一致。
 *
 * 手动脚本而非 vitest 用例，原因：它依赖真实进程信号与真实 tsx 启动，
 * 在 CI 里作为独立步骤跑（`pnpm test:kill9`），避免把进程级不确定性带进单测。
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childPath = join(repoRoot, 'packages/hub/test/manual/kill9-child.ts')

const failures: string[] = []

function check(ok: boolean, message: string): void {
  if (ok) {
    process.stdout.write(`✓ ${message}\n`)
    return
  }
  process.stdout.write(`✗ ${message}\n`)
  failures.push(message)
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) {
        resolve(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hubagent-kill9-'))
  const dbFile = join(dir, 'state.db')

  try {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, dbFile], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    })

    const seqs: number[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) seqs.push(Number(line))
        newline = buffer.indexOf('\n')
      }
    })

    const enough = await waitFor(() => seqs.length >= 20, 10_000)
    check(enough, `子进程写出足够事件（收到 ${seqs.length} 条 seq）`)

    child.kill('SIGKILL')
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
    })
    check(exitCode === null, `进程被 SIGKILL 终止（exitCode=${String(exitCode)}）`)

    // —— 重启：只靠数据库自身恢复 ——
    const db = openDatabase(dbFile)
    try {
      check(integrityCheck(db) === 'ok', 'integrity_check 通过')
      check(pragmaValue(db, 'journal_mode') === 'wal', 'journal_mode = wal')

      const count = eventCount(db)
      const maxSeq = lastSeq(db)
      check(count > 10, `事件已落盘（count=${count}）`)
      check(maxSeq >= count, `seq 与事件数自洽（lastSeq=${maxSeq}, count=${count}）`)

      const replayed = replayAll(db)
      check(replayed.events === count, `重放条数一致（${replayed.events}）`)
      check(appliedSeq(db) === maxSeq, `投影位点追上事件流（${appliedSeq(db)} == ${maxSeq}）`)

      const projected = loadState(db)
      check(isDeepStrictEqual(projected, replayed.state), '投影与事件重放逐字段一致（无半写状态）')

      const strictlyIncreasing = seqs.every(
        (value, index) => index === 0 || value > (seqs[index - 1] ?? 0),
      )
      check(strictlyIncreasing, '观测到的 seq 严格递增')
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.stdout.write(`\n失败 ${failures.length} 项。\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write('\nkill -9 一致性通过。\n')
}

await main()
