#!/usr/bin/env node
/** 兼容入口：`hubagent` 与 `ha` 是同一个 CLI。 */
import { createCli } from '../interfaces/cli/cli'

const version = process.env['HUBAGENT_VERSION'] ?? '0.0.0-m0'

createCli(version)
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ha: ${message}\n`)
    process.exitCode = 1
  })
