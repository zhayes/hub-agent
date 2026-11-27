import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentHost } from '../agent-host/agent-host'
import type { VerificationCheck, VerificationCheckResult } from '../domain/entities'
import type { SandboxNetworkMode } from '../sandbox/types'
import { newId } from '../shared/id'
import type { Db } from '../storage/db'
import { findDispatchByIdempotencyKey } from './dispatch/queue'
import { runVerification } from './verify/runner'

/**
 * 远端交付物的本地应用与验收（PRD §7.7）。
 *
 * 原则：**验的是“应用后的产物”，不是远端的自述**。所以顺序固定为
 * 写 patch → 检查能否干净应用 → 应用 → 在本地 worktree 跑确定性检查。
 *
 * 所有命令都经 AgentHost（因此经 SandboxProvider），不在 Runtime 里直接起进程。
 */

/** 验收规格：随派发意图一起落库，重启后仍能重建（不依赖内存）。 */
export interface RemoteVerificationSpec {
  worktree: string
  checks?: readonly VerificationCheck[]
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  allowedWrite?: readonly string[]
}

export interface ApplyAndVerifyInput {
  host: AgentHost
  executionId: string
  spec: RemoteVerificationSpec
  /** 内联 patch 内容；没有则只跑 checks（等价于验证本地既有状态）。 */
  patch?: { content: string; filename?: string }
  /** patch 落盘目录；缺省放在 worktree 之外，避免污染仓库。 */
  artifactDir: string
}

export type PatchOutcome = 'none' | 'applied' | 'already-applied' | 'rejected'

export interface ApplyAndVerifyResult {
  verdict: 'pass' | 'fail' | 'manual_required'
  checks: VerificationCheckResult[]
  patch: PatchOutcome
  /** 失败/降级的原因，供 DecisionRecord 与人工排查。 */
  detail?: string
  sandboxDenied?: { source: string; text: string }
}

/**
 * 应用 patch 并跑验收。
 *
 * 幂等：已经应用过的 patch 用 `git apply --reverse --check` 识别并跳过，
 * 因此对账重复执行不会把“已应用”误判成“冲突”。
 */
export async function applyAndVerify(input: ApplyAndVerifyInput): Promise<ApplyAndVerifyResult> {
  const { host, spec, executionId, artifactDir } = input
  let patch: PatchOutcome = 'none'
  let detail: string | undefined

  if (input.patch !== undefined) {
    const file = writePatch(artifactDir, input.patch)
    const worktree = spec.worktree

    const reversed = await git(host, worktree, ['apply', '--reverse', '--check', file])
    if (reversed.code === 0) {
      patch = 'already-applied'
    } else {
      const check = await git(host, worktree, ['apply', '--check', file])
      if (check.code !== 0) {
        /* 干净应用不了 = 基线不一致。**不得**把远端 COMPLETED 转成本地成功。 */
        return {
          verdict: 'fail',
          checks: [],
          patch: 'rejected',
          detail: `patch 无法在本地基线干净应用：${(check.stderr || check.stdout).trim().slice(0, 500)}`,
        }
      }
      const applied = await git(host, worktree, ['apply', file])
      if (applied.code !== 0) {
        return {
          verdict: 'fail',
          checks: [],
          patch: 'rejected',
          detail: `patch 应用失败：${(applied.stderr || applied.stdout).trim().slice(0, 500)}`,
        }
      }
      patch = 'applied'
    }
  }

  const verification = await runVerification({
    executionId,
    worktree: spec.worktree,
    checks: spec.checks ?? [],
    artifactDir,
    host,
    ...(spec.networkMode === undefined ? {} : { networkMode: spec.networkMode }),
    ...(spec.allowedDomains === undefined ? {} : { allowedDomains: spec.allowedDomains }),
    ...(spec.allowedWrite === undefined ? {} : { allowedWrite: spec.allowedWrite }),
  })

  if (verification.sandboxDenied !== undefined) {
    detail = `本地检查被沙箱拒绝：${verification.sandboxDenied.source}`
  }

  return {
    verdict: verification.run.verdict,
    checks: verification.run.checks,
    patch,
    ...(detail === undefined ? {} : { detail }),
    ...(verification.sandboxDenied === undefined
      ? {}
      : { sandboxDenied: verification.sandboxDenied }),
  }
}

/** 把 patch 落到 artifact 目录（不写进仓库，避免污染 worktree 与 diffScope）。 */
function writePatch(artifactDir: string, patch: { content: string; filename?: string }): string {
  mkdirSync(artifactDir, { recursive: true })
  const path = join(artifactDir, patch.filename ?? 'remote-changes.patch')
  writeFileSync(path, patch.content, 'utf8')
  return path
}

interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

async function git(host: AgentHost, worktree: string, args: readonly string[]): Promise<GitResult> {
  const process = await host.spawn(`remote-git-${newId()}`, {
    worktree,
    command: `git ${args.map(quote).join(' ')}`,
    sandbox: { allowedWrite: [worktree] },
    timeouts: { startupMs: 30_000, idleMs: 30_000, totalMs: 60_000, killGraceMs: 1_000 },
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  })
  const exit = await process.wait()
  return {
    code: exit.reason === 'exited' ? exit.code : null,
    stdout: exit.stdout,
    stderr: exit.stderr,
  }
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * 组装一个可注入 `reconcileRemoteTasks({ verify })` 的验收器。
 *
 * 规格（worktree / checks）从派发意图的 payload 里读——它是 Runtime 自己写的，
 * 且已落库，所以 daemon 重启后仍能验收，不依赖发起回合的内存。
 */
export function createRemoteVerifier(options: {
  db: Db
  host: AgentHost
  artifactDir?: string
}): (input: {
  ref: { idempotencyKey: string }
  patch?: { content: string; filename?: string }
  executionId: string
}) => Promise<ApplyAndVerifyResult | undefined> {
  return async (input) => {
    const intent = findDispatchByIdempotencyKey(options.db, input.ref.idempotencyKey)
    const spec = verificationSpecOf(intent?.payload)
    if (spec === undefined) return undefined
    return applyAndVerify({
      host: options.host,
      executionId: input.executionId,
      spec,
      ...(input.patch === undefined ? {} : { patch: input.patch }),
      artifactDir: options.artifactDir ?? join(spec.worktree, '.hubagent', 'remote'),
    })
  }
}

/** 从派发 payload 里取验收规格；缺字段就当没有规格（→ 人工验收）。 */
export function verificationSpecOf(payload: unknown): RemoteVerificationSpec | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const verification = (payload as Record<string, unknown>)['verification']
  if (typeof verification !== 'object' || verification === null) return undefined
  const record = verification as Record<string, unknown>
  const worktree = record['worktree']
  if (typeof worktree !== 'string' || worktree === '') return undefined

  const checks = Array.isArray(record['checks'])
    ? (record['checks'] as VerificationCheck[])
    : undefined
  const networkMode =
    typeof record['networkMode'] === 'string'
      ? (record['networkMode'] as SandboxNetworkMode)
      : undefined
  const allowedDomains = stringArray(record['allowedDomains'])
  const allowedWrite = stringArray(record['allowedWrite'])

  return {
    worktree,
    ...(checks === undefined ? {} : { checks }),
    ...(networkMode === undefined ? {} : { networkMode }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(allowedWrite === undefined ? {} : { allowedWrite }),
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}
