import { useApp } from '../app/store'
import { AgentsView } from '../features/agents/AgentsView'

export function AgentsRoute() {
  const app = useApp()
  return <AgentsView agents={app.agents()} t={app.t} />
}
