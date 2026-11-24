/**
 * TC-014 库方式探针
 *
 * 验证三件事：
 *   1. 用 wrapWithSandboxArgv（生产要用的 argv 形式）能否拦住越界；
 *   2. 合法操作不被误伤；
 *   3. 「违规可归因」—— 这是 §12.1「违规即审批」的前提。
 *
 * 用法：
 *   cd poc/tc-014 && npm i && npm run probe
 *
 * 注意：@anthropic-ai/sandbox-runtime 处于 0.0.x，API 可能变动。
 * 所有可选 API 都做了能力探测，缺失时打印 SKIP 而不是崩掉。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'

type AnyRec = Record<string, any>
const mgr = SandboxManager as unknown as AnyRec
const call = (name: string, ...args: unknown[]): any =>
  typeof mgr[name] === 'function' ? mgr[name](...args) : undefined

const work = mkdtempSync(join(tmpdir(), 'tc014-probe-'))
const secretDir = join(work, 'secret')
const projectDir = join(work, 'project')
mkdirSync(secretDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(secretDir, 'canary.txt'), 'canary\n')
writeFileSync(join(projectDir, 'ok.txt'), 'ok\n')

const config = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: {
    denyRead: [secretDir],
    allowWrite: [work],
    denyWrite: [],
  },
}

type RunResult = { code: number | null; stderr: string }

/** 用 argv 形式包装后执行（生产路径）。回退到字符串形式时用 sh -c。 */
async function runWrapped(command: string, commandId: string): Promise<RunResult> {
  const wrapArgv = mgr['wrapWithSandboxArgv']
  const wrapStr = mgr['wrapWithSandbox']
  let file: string
  let args: string[]

  let extraEnv: Record<string, string> = {}

  if (typeof wrapArgv === 'function') {
    const res = await wrapArgv(command, undefined, undefined, undefined, { commandId })
    if (Array.isArray(res)) {
      file = res[0]
      args = res.slice(1)
    } else if (res && Array.isArray((res as AnyRec).argv)) {
      // 实测结构：{ argv: string[], env: Record<string,string> }
      const r = res as AnyRec
      file = r.argv[0]
      args = r.argv.slice(1)
      if (r.env && typeof r.env === 'object') extraEnv = r.env as Record<string, string>
    } else if (typeof res === 'string') {
      file = 'sh'
      args = ['-c', res]
    } else {
      throw new Error(`wrapWithSandboxArgv 返回了未知结构: ${typeof res}`)
    }
  } else if (typeof wrapStr === 'function') {
    console.log('    (wrapWithSandboxArgv 不存在，回退到字符串形式)')
    const wrapped = await wrapStr(command, undefined, undefined, undefined, { commandId })
    file = 'sh'
    args = ['-c', wrapped]
  } else {
    throw new Error('没有可用的包装 API')
  }

  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: projectDir,
      env: { ...process.env, ...extraEnv },
    })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.stdout?.resume()
    child.on('exit', code => resolve({ code, stderr }))
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('workdir      :', work)
  console.log('平台支持      :', call('isSupportedPlatform') ?? 'n/a')
  console.log('沙箱已启用    :', call('isSandboxingEnabled') ?? 'n/a')

  const deps = call('checkDependencies')
  if (deps !== undefined) {
    console.log('依赖检查      :', JSON.stringify(deps).slice(0, 300))
  }

  await call('initialize', config)
  console.log('沙箱已启用    :', call('isSandboxingEnabled') ?? 'n/a')
  console.log('包装器        :', 'argv 形式（生产路径）')

  // ---- 用例 1：越界读，期望被拒 ----
  const deniedId = 'probe-denied'
  const denied = await runWrapped(`cat '${join(secretDir, 'canary.txt')}'`, deniedId)
  const isDenied = denied.code !== 0
  console.log(`\n[1] 越界读 → exit=${denied.code} ${isDenied ? '✅ 被拒' : '❌ 未被拒'}`)
  if (denied.stderr) console.log('    stderr:', denied.stderr.trim().split('\n')[0])

  // ---- 用例 2：合法读，期望通过 ----
  const allowedId = 'probe-allowed'
  const allowed = await runWrapped(`cat '${join(projectDir, 'ok.txt')}'`, allowedId)
  console.log(`\n[2] 合法读 → exit=${allowed.code} ${allowed.code === 0 ? '✅ 通过' : '❌ 被误伤'}`)

  // ---- 用例 3：违规归因 ----
  console.log('\n[3] 违规归因')
  let attributable = false

  // macOS 的 violation 来自系统 log stream，是异步的，多等一会
  await sleep(3000)

  const store = call('getSandboxViolationStore')
  if (store) {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(store))
    console.log('    violation store 方法:', proto.join(', ') || '(none)')
    for (const name of ['getTotalCount', 'getCount']) {
      const fn = (store as AnyRec)[name]
      if (typeof fn !== 'function') continue
      try {
        console.log(`    ${name}() →`, await Promise.resolve(fn.call(store)))
      } catch (e) {
        console.log(`    ${name} 调用失败: ${(e as Error).message}`)
      }
    }
    for (const name of ['getViolations', 'getAll', 'get', 'getViolationsForCommand']) {
      const fn = (store as AnyRec)[name]
      if (typeof fn !== 'function') continue
      try {
        const raw = await Promise.resolve(fn.call(store, deniedId))
        const n = Array.isArray(raw) ? raw.length : raw ? 1 : 0
        console.log(`    ${name}(${deniedId}) → ${n} 条`)
        if (n > 0) attributable = true
      } catch (e) {
        console.log(`    ${name} 调用失败: ${(e as Error).message}`)
      }
    }
  } else {
    console.log('    SKIP getSandboxViolationStore 不存在')
  }

  if (typeof mgr['annotateStderrWithSandboxFailures'] === 'function') {
    const annotated = mgr['annotateStderrWithSandboxFailures'](deniedId, denied.stderr)
    const changed = typeof annotated === 'string' && annotated !== denied.stderr
    console.log(`    annotateStderr → ${changed ? '✅ 注入成功' : '⚠️  无变化'}`)
    if (changed) {
      attributable = true
      console.log('    注入内容:', annotated.trim().split('\n')[0].slice(0, 160))
    }
  }

  // ---- 用例 4：合法操作不应产生违规 ----
  if (store && typeof (store as AnyRec)['getViolations'] === 'function') {
    const raw = await Promise.resolve((store as AnyRec)['getViolations'](allowedId))
    const n = Array.isArray(raw) ? raw.length : raw ? 1 : 0
    console.log(`\n[4] 合法操作的违规数 → ${n} ${n === 0 ? '✅ 无误报' : '⚠️  存在误报'}`)
  }

  await call('reset')

  // ---- 结论 ----
  console.log('\n===== 结论 =====')
  const bothWays = isDenied && allowed.code === 0
  console.log(bothWays ? '✅ 双向验证通过：能拦，且没误伤。' : '❌ 双向验证未通过。')
  console.log(
    attributable
      ? '✅ 违规可归因 → §12.1「违规即审批」可按设计实现。'
      : '⚠️  拿到不到可归因的违规记录 → 需降级为「stderr 关键字匹配」，记入风险。',
  )
  process.exitCode = bothWays ? 0 : 1
}

main().catch(err => {
  console.error('探针失败:', err)
  process.exitCode = 1
})
