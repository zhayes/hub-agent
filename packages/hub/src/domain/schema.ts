import { z } from 'zod'
import {
  asAgentId,
  asApprovalId,
  asContractId,
  asExecutionId,
  asGoalId,
  asSessionId,
  asSubtaskId,
  asTaskId,
  asTimestamp,
  asVerificationRunId,
} from './ids'
import {
  APPROVAL_STATUSES,
  EXECUTION_STATUSES,
  GOAL_STATUSES,
  SUBTASK_STATUSES,
  TASK_STATUSES,
} from './status'

/**
 * Zod schema 是 HTTP / 事件 / Brain 输出共用的唯一校验来源。
 * 此处通过 transform 保留品牌类型，使 z.infer 与实体类型一致。
 */
const nonEmpty = z.string().min(1)

const goalIdSchema = nonEmpty.transform(asGoalId)
const taskIdSchema = nonEmpty.transform(asTaskId)
const subtaskIdSchema = nonEmpty.transform(asSubtaskId)
const executionIdSchema = nonEmpty.transform(asExecutionId)
const verificationRunIdSchema = nonEmpty.transform(asVerificationRunId)
const approvalIdSchema = nonEmpty.transform(asApprovalId)
const contractIdSchema = nonEmpty.transform(asContractId)
const agentIdSchema = nonEmpty.transform(asAgentId)
const sessionIdSchema = nonEmpty.transform(asSessionId)
const timestampSchema = nonEmpty.transform(asTimestamp)

export const goalSchema = z.object({
  id: goalIdSchema,
  userId: nonEmpty,
  title: nonEmpty,
  intent: nonEmpty,
  status: z.enum(GOAL_STATUSES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const taskSchema = z.object({
  id: taskIdSchema,
  goalId: goalIdSchema,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.number().int(),
  acceptanceCriteria: z.array(z.string()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const subtaskSchema = z.object({
  id: subtaskIdSchema,
  taskId: taskIdSchema,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(SUBTASK_STATUSES),
  required: z.boolean(),
  dependencies: z.array(subtaskIdSchema),
  requiredCapabilities: z.array(z.string()),
  assignedAgentId: agentIdSchema.optional(),
  priority: z.number().int(),
  maxAttempts: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export const verificationCheckSchema = z.object({
  checkId: nonEmpty,
  kind: z.enum(['command', 'fileExists', 'diffScope', 'noUnexpectedChange', 'llmReview']),
  passed: z.boolean(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  outputRef: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
})

export const executionEvidenceSchema = z.object({
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  diffstat: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  transcriptRef: z.string().optional(),
})

export const executionSchema = z.object({
  id: executionIdSchema,
  taskId: taskIdSchema,
  subtaskId: subtaskIdSchema,
  agentId: agentIdSchema,
  sessionId: sessionIdSchema.optional(),
  status: z.enum(EXECUTION_STATUSES),
  attempt: z.number().int().min(1),
  evidence: executionEvidenceSchema.optional(),
  failureCategory: z.enum(['protocol', 'agent', 'resource', 'verification', 'budget']).optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
})

export const verificationRunSchema = z.object({
  id: verificationRunIdSchema,
  executionId: executionIdSchema,
  checks: z.array(verificationCheckSchema),
  verdict: z.enum(['pass', 'fail', 'manual_required']),
  decidedBy: z.enum(['runtime', 'brain', 'human']),
  createdAt: timestampSchema,
})

export const approvalSchema = z.object({
  id: approvalIdSchema,
  taskId: taskIdSchema,
  executionId: executionIdSchema.optional(),
  agentId: agentIdSchema.optional(),
  action: nonEmpty,
  resource: nonEmpty,
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  requestedBy: z.enum(['brain', 'runtime', 'agent']),
  reason: nonEmpty,
  decisionMode: z.enum(['once', 'policy']).optional(),
  policyId: z.string().optional(),
  status: z.enum(APPROVAL_STATUSES),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  decidedAt: timestampSchema.optional(),
})

export const taskBriefSchema = z.object({
  objective: nonEmpty,
  constraints: z.array(z.string()),
  contextRefs: z.array(z.string()),
  existingConventions: z.array(z.string()),
  acceptance: z.array(z.string()),
  outOfScope: z.array(z.string()),
  knownPitfalls: z.array(z.string()),
})

export const delegationContractSchema = z.object({
  id: contractIdSchema,
  subtaskId: subtaskIdSchema,
  executionId: executionIdSchema.optional(),
  requirements: z.object({
    capabilities: z.array(z.string()),
    minReliability: z.number().min(0).max(1).optional(),
    preferredAgentId: agentIdSchema.optional(),
  }),
  brief: taskBriefSchema,
  workspace: z.object({
    projectId: nonEmpty,
    isolation: z.enum(['shared', 'worktree', 'copy']),
    allowedPaths: z.array(z.string()),
    baseRef: z.string().optional(),
  }),
  budget: z.object({
    maxWallClockMs: z.number().int().positive(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  }),
  policy: z.object({
    allowRedelegate: z.boolean(),
    requiresApproval: z.boolean(),
    captureTranscript: z.boolean(),
  }),
  idempotencyKey: nonEmpty,
  expiresAt: timestampSchema.optional(),
})

export const domainEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goal.created'), goal: goalSchema }),
  z.object({
    type: z.literal('goal.status'),
    goalId: goalIdSchema,
    to: z.enum(GOAL_STATUSES),
    at: timestampSchema,
  }),
  z.object({ type: z.literal('task.created'), task: taskSchema }),
  z.object({
    type: z.literal('task.status'),
    taskId: taskIdSchema,
    to: z.enum(TASK_STATUSES),
    at: timestampSchema,
  }),
  z.object({ type: z.literal('subtask.created'), subtask: subtaskSchema }),
  z.object({
    type: z.literal('subtask.status'),
    subtaskId: subtaskIdSchema,
    to: z.enum(SUBTASK_STATUSES),
    at: timestampSchema,
  }),
  z.object({ type: z.literal('execution.created'), execution: executionSchema }),
  z.object({
    type: z.literal('execution.status'),
    executionId: executionIdSchema,
    to: z.enum(EXECUTION_STATUSES),
    at: timestampSchema,
  }),
  z.object({
    type: z.literal('execution.evidence'),
    executionId: executionIdSchema,
    evidence: executionEvidenceSchema,
  }),
  z.object({ type: z.literal('verification.recorded'), run: verificationRunSchema }),
  z.object({ type: z.literal('approval.requested'), approval: approvalSchema }),
  z.object({
    type: z.literal('approval.decided'),
    approvalId: approvalIdSchema,
    status: z.enum(APPROVAL_STATUSES),
    at: timestampSchema,
  }),
])
