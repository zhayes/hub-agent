import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 运行期文件布局（ARCHITECTURE §11.1）。
 * HUBAGENT_HOME 用于测试与隔离实例，默认落在 ~/.hubagent。
 */
export function hubDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
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

/** Hub 自己的 Pi profile：models.json / settings.json 放在这里。 */
export function piAgentDir(dir: string): string {
  return join(dir, 'pi-agent')
}

/**
 * Pi 的 agent directory。显式 HUBAGENT_PI_AGENT_DIR 优先（沿用旧行为）；
 * 否则用 hub 私有 profile——用户的 ~/.pi/agent 不被控制台改写。
 */
export function resolvePiAgentDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env['HUBAGENT_PI_AGENT_DIR']?.trim()
  return override !== undefined && override.length > 0 ? override : piAgentDir(hubDir(env))
}
