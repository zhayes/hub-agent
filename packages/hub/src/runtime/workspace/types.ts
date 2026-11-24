export type WorkspaceMode = 'shared' | 'worktree' | 'copy'
export type WorkspaceLeaseStatus = 'active' | 'released' | 'expired' | 'abandoned'

export interface WorkspaceLease {
  id: string
  projectId: string
  executionId: string
  mode: WorkspaceMode
  path: string
  branch?: string
  baseRef?: string
  holderAgentId: string
  status: WorkspaceLeaseStatus
  acquiredAt: string
  expiresAt?: string
  releasedAt?: string
}

export interface AcquireLeaseInput {
  projectId: string
  executionId: string
  mode: WorkspaceMode
  path: string
  holderAgentId: string
  branch?: string
  baseRef?: string
  ttlMs?: number
}
