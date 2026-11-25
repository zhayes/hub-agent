import { StageEntry } from '../features/agents/office/stage-entry'

/** `/agents` 只保留 3D 舞台；旧的表格在 A6 删除（PLAN-AGENT-OFFICE §1.1）。 */
export function AgentsRoute() {
  return <StageEntry />
}
