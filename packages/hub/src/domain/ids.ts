/**
 * 品牌化 ID。
 *
 * 领域层是纯模型（R1：不得 import 任何其他层），所以 ID 生成不放在这里。
 * 生成在 storage / 调用方完成，domain 只负责"类型上不可混用"。
 */
declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type GoalId = Brand<string, 'GoalId'>
export type TaskId = Brand<string, 'TaskId'>
export type SubtaskId = Brand<string, 'SubtaskId'>
export type ExecutionId = Brand<string, 'ExecutionId'>
export type VerificationRunId = Brand<string, 'VerificationRunId'>
export type ApprovalId = Brand<string, 'ApprovalId'>
export type ContractId = Brand<string, 'ContractId'>
export type AgentId = Brand<string, 'AgentId'>
export type SessionId = Brand<string, 'SessionId'>
export type Timestamp = Brand<string, 'Timestamp'>

export const asGoalId = (value: string): GoalId => value as GoalId
export const asTaskId = (value: string): TaskId => value as TaskId
export const asSubtaskId = (value: string): SubtaskId => value as SubtaskId
export const asExecutionId = (value: string): ExecutionId => value as ExecutionId
export const asVerificationRunId = (value: string): VerificationRunId => value as VerificationRunId
export const asApprovalId = (value: string): ApprovalId => value as ApprovalId
export const asContractId = (value: string): ContractId => value as ContractId
export const asAgentId = (value: string): AgentId => value as AgentId
export const asSessionId = (value: string): SessionId => value as SessionId
export const asTimestamp = (value: string): Timestamp => value as Timestamp
