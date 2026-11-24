import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 运行期文件布局（ARCHITECTURE §11.1）。
 * HUBAGENT_HOME 用于测试与隔离实例，默认落在 ~/.hubagent。
 */
export function hubDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HUBAGENT_HOME']
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.hubagent')
}

export function configPath(dir: string): string {
  return join(dir, 'config.toml')
}

export function lockPath(dir: string): string {
  return join(dir, 'hubagent.lock')
}

export function dbPath(dir: string): string {
  return join(dir, 'state.db')
}

export function tokenPath(dir: string): string {
  return join(dir, 'token')
}
