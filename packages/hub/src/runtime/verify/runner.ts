import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentHost } from '../../agent-host/agent-host'
import type {
  VerificationCheck,
  VerificationCheckResult,
  VerificationRun,
} from '../../domain/entities'
import { asExecutionId, asTimestamp, asVerificationRunId } from '../../domain/ids'
import type { SandboxNetworkMode } from '../../sandbox/types'
import { newId } from '../../shared/id'

/**
 * Verification Runner：确定性验收，不调用被验收 Agent，不采信其自述。
 *
 * 所有命令经 AgentHost（因此经 SandboxProvider）执行；cwd 固定为 worktree。
 * 大输出落 artifact 文件，VerificationCheckResult 只存引用。
 */

export interface VerificationContext {
  executionId: string
  worktree: string
  checks: readonly VerificationCheck[]
  /** 执行结束采集到的 changedFiles；用于 diffScope / noUnexpectedChange */
  changedFiles?: readonly string[]
  artifactDir: string
  host: AgentHost
  networkMode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  allowedWrite?: readonly string[]
}

export interface SandboxDeniedEvidence {
  source: string
  text: string
}

export interface VerificationOutcome {
  run: VerificationRun
  sandboxDenied?: SandboxDeniedEvidence
}

const SANDBOX_DENIAL_PATTERN =
  /operation not permitted|not permitted|sandbox_denied|eperm|blocked by sandbox|connect tunnel failed|denied by sandbox/i

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function withinAllowed(path: string, allowedPaths: readonly string[]): boolean {
  const normalized = normalizePath(path)
  return allowedPaths.some((allowed) => {
    const prefix = normalizePath(allowed).replace(/\/$/, '')
    return (
      prefix === '.' ||
      prefix === '' ||
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`)
    )
  })
}

function safeResolve(worktree: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined
  const root = resolve(worktree)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined
  return target
}

function writeArtifact(artifactDir: string, checkId: string, content: string): string {
  mkdirSync(artifactDir, { recursive: true })
  const path = join(artifactDir, `${checkId}.log`)
  writeFileSync(path, content, 'utf8')
  return path
}

async function runCommand(
  context: VerificationContext,
  check: Extract<VerificationCheck, { kind: 'command' }>,
  checkId: string,
): Promise<{ result: VerificationCheckResult; denied?: SandboxDeniedEvidence }> {
  const timeoutMs = check.timeoutMs
  const process = await context.host.spawn(`verify-${checkId}-${newId()}`, {
    worktree: context.worktree,
    command: check.cmd,
    sandbox: {
      allowedWrite: context.allowedWrite ?? [],
      ...(context.networkMode === undefined ? {} : { networkMode: context.networkMode }),
      ...(context.allowedDomains === undefined ? {} : { allowedDomains: context.allowedDomains }),
    },
    timeouts: {
      startupMs: timeoutMs,
      idleMs: timeoutMs,
      totalMs: timeoutMs,
      killGraceMs: 1_000,
    },
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
  })
  const exit = await process.wait()

  const expected = Array.isArray(check.expect.exitCode)
    ? check.expect.exitCode
    : [check.expect.exitCode]
  const passed = exit.reason === 'exited' && exit.code !== null && expected.includes(exit.code)
  const outputRef = writeArtifact(
    context.artifactDir,
    checkId,
    [
      `$ ${check.cmd}`,
      `reason=${exit.reason} exitCode=${String(exit.code)} signal=${String(exit.signal)} durationMs=${exit.durationMs}`,
      '',
      '--- stdout ---',
      exit.stdout,
      '--- stderr ---',
      exit.stderr,
    ].join('\n'),
  )

  const denied = SANDBOX_DENIAL_PATTERN.test(`${exit.stdout}\n${exit.stderr}`)
    ? { source: check.cmd, text: `${exit.stdout}\n${exit.stderr}`.trim() }
    : undefined

  return {
    result: {
      checkId,
      kind: 'command',
      passed,
      command: check.cmd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      outputRef,
      durationMs: exit.durationMs,
    },
    ...(denied === undefined ? {} : { denied }),
  }
}

export async function runVerification(context: VerificationContext): Promise<VerificationOutcome> {
  const results: VerificationCheckResult[] = []
  let sandboxDenied: SandboxDeniedEvidence | undefined

  for (const [index, check] of context.checks.entries()) {
    const checkId = `check-${index + 1}`
    if (check.kind === 'command') {
      const outcome = await runCommand(context, check, checkId)
      results.push(outcome.result)
      if (outcome.denied !== undefined && sandboxDenied === undefined) {
        sandboxDenied = outcome.denied
      }
      continue
    }

    if (check.kind === 'fileExists') {
      const target = safeResolve(context.worktree, check.path)
      const passed = target !== undefined && existsSync(target)
      const outputRef = writeArtifact(
        context.artifactDir,
        checkId,
        `fileExists path=${check.path} resolved=${target ?? '<outside worktree>'} passed=${passed}`,
      )
      results.push({ checkId, kind: 'fileExists', passed, outputRef })
      continue
    }

    if (check.kind === 'diffScope') {
      const changed = [...(context.changedFiles ?? [])]
      const violations = changed.filter((file) => !withinAllowed(file, check.allowedPaths))
      const passed = violations.length === 0
      const outputRef = writeArtifact(
        context.artifactDir,
        checkId,
        [
          `diffScope allowed=${check.allowedPaths.join(',')}`,
          `changed=${changed.join(',') || '<none>'}`,
          `violations=${violations.join(',') || '<none>'}`,
        ].join('\n'),
      )
      results.push({ checkId, kind: 'diffScope', passed, outputRef })
      continue
    }

    if (check.kind === 'noUnexpectedChange') {
      const changed = [...(context.changedFiles ?? [])].map(normalizePath)
      const unexpected = changed.filter((file) =>
        check.paths.some((path) => {
          const normalized = normalizePath(path)
          return file === normalized || file.startsWith(`${normalized}/`)
        }),
      )
      const passed = unexpected.length === 0
      const outputRef = writeArtifact(
        context.artifactDir,
        checkId,
        [
          `noUnexpectedChange paths=${check.paths.join(',')}`,
          `changed=${changed.join(',') || '<none>'}`,
          `unexpected=${unexpected.join(',') || '<none>'}`,
        ].join('\n'),
      )
      results.push({ checkId, kind: 'noUnexpectedChange', passed, outputRef })
      continue
    }

    // llmReview：M5 只做人工标记，不做 LLM 评审；不能默认通过。
    const outputRef = writeArtifact(
      context.artifactDir,
      checkId,
      `llmReview rubric=${check.rubric}\nevidenceRefs=${check.evidenceRefs.join(',')}`,
    )
    results.push({
      checkId,
      kind: 'llmReview',
      passed: false,
      manualRequired: true,
      outputRef,
    })
  }

  const failed = results.some((result) => !result.passed && result.manualRequired !== true)
  const manual = results.length === 0 || results.some((result) => result.manualRequired === true)
  const verdict = failed ? 'fail' : manual ? 'manual_required' : 'pass'

  const run: VerificationRun = {
    id: asVerificationRunId(newId()),
    executionId: asExecutionId(context.executionId),
    checks: results,
    verdict,
    decidedBy: 'runtime',
    createdAt: asTimestamp(new Date().toISOString()),
  }

  return {
    run,
    ...(sandboxDenied === undefined ? {} : { sandboxDenied }),
  }
}

/** 供 CLI/排障展示：把 changedFiles 相对 worktree 归一化 */
export function relativeChangedFiles(worktree: string, files: readonly string[]): string[] {
  return files.map((file) => normalizePath(relative(worktree, resolve(worktree, file))))
}
