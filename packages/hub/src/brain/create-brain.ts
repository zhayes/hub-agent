import { HubError } from '../shared/errors'
import { PiBrain } from './pi/pi-brain'
import { createPiSessionFactory } from './pi/session'
import { ScriptedBrain } from './scripted-brain'
import type { OrchestratorBrain } from './types'

export interface BrainEnv {
  HUBAGENT_BRAIN_MODE?: string
  HUBAGENT_PI_AGENT_DIR?: string
  HUBAGENT_BRAIN_CWD?: string
}

/**
 * 默认 Pi SDK Brain；显式 HUBAGENT_BRAIN_MODE=scripted 才用测试替身。
 * 不再维护第二套 OpenAI-compatible client。
 */
export function createBrainFromEnv(env: BrainEnv = process.env): OrchestratorBrain {
  const explicit = env.HUBAGENT_BRAIN_MODE?.trim().toLowerCase()
  const mode = explicit === undefined || explicit === '' ? 'pi' : explicit
  if (mode === 'scripted') return new ScriptedBrain()
  if (mode !== 'pi') {
    throw new HubError('CONFIG_INVALID', `HUBAGENT_BRAIN_MODE 只能是 pi | scripted：${mode}`)
  }
  return new PiBrain({
    factory: createPiSessionFactory({
      ...(env.HUBAGENT_PI_AGENT_DIR === undefined ? {} : { agentDir: env.HUBAGENT_PI_AGENT_DIR }),
    }),
    ...(env.HUBAGENT_BRAIN_CWD === undefined ? {} : { cwd: env.HUBAGENT_BRAIN_CWD }),
    ...(env.HUBAGENT_PI_AGENT_DIR === undefined ? {} : { agentDir: env.HUBAGENT_PI_AGENT_DIR }),
  })
}
