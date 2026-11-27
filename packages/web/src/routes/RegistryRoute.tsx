import { AgentsPage } from '../features/agents/AgentsPage'

/** `/registry`：同一目的地的「接入」分段（catalog 扫描与授权）。路径保留，书签不失效。 */
export function RegistryRoute() {
  return <AgentsPage section="access" />
}
