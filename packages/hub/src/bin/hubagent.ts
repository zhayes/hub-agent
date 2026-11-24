#!/usr/bin/env node
import { createCli } from '../interfaces/cli/cli'

const version = process.env['HUBAGENT_VERSION'] ?? '0.0.0-m0'

createCli(version)
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`hubagent: ${message}\n`)
    process.exitCode = 1
  })
