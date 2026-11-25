import { HubError } from '../shared/errors'
import { resolvePiAgentDir } from '../shared/paths'
import { PiBrain } from './pi/pi-brain'
import { createPiSessionFactory } from './pi/session'
import { ScriptedBrain } from './scripted-brain'
import type { OrchestratorBrain } from './types'

export type BrainEnv = {
  HUBAGENT_BRAIN_MODE?: string
  HUBAGENT_PI_AGENT_DIR?: string
  HUBAGENT_BRAIN_CWD?: string
  HUBAGENT_HOME?: string
}

/**
 * 默认 Pi SDK Brain；显式 HUBAGENT_BRAIN_MODE=scripted 才用测试替身。
 * 不再维护第二套 OpenAI-compatible client。
 *
 * agentDir 走 hub 自己的 Pi profile（`<hubDir>/pi-agent`），除非显式
 * HUBAGENT_PI_AGENT_DIR；控制台的模型设置就写在那里。
 */
export function createBrainFromEnv(env: BrainEnv = process.env): OrchestratorBrain {
  const explicit = env.HUBAGENT_BRAIN_MODE?.trim().toLowerCase()
  const mode = explicit === undefined || explicit === '' ? 'pi' : explicit
  if (mode === 'scripted') return new ScriptedBrain()
  if (mode !== 'pi') {
    throw new HubError('CONFIG_INVALID', `HUBAGENT_BRAIN_MODE 只能是 pi | scripted：${mode}`)
  }
  const agentDir = resolvePiAgentDir({
    ...(env.HUBAGENT_HOME === undefined ? {} : { HUBAGENT_HOME: env.HUBAGENT_HOME }),
    ...(env.HUBAGENT_PI_AGENT_DIR === undefined
      ? {}
      : { HUBAGENT_PI_AGENT_DIR: env.HUBAGENT_PI_AGENT_DIR }),
  })
  return new PiBrain({
    factory: createPiSessionFactory({ agentDir }),
    ...(env.HUBAGENT_BRAIN_CWD === undefined ? {} : { cwd: env.HUBAGENT_BRAIN_CWD }),
    agentDir,
  })
}
