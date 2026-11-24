import { useApp } from '../app/store'
import { ApprovalsView } from '../features/approvals/ApprovalsView'

export function ApprovalsRoute() {
  const app = useApp()
  return (
    <ApprovalsView
      approvals={app.approvals()}
      t={app.t}
      onApprove={(id) => void app.decide(id, 'approve')}
      onReject={(id) => void app.decide(id, 'reject')}
    />
  )
}
