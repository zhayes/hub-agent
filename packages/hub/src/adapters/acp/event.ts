import type {
  AgentCapabilities,
  Implementation,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'

/**
 * ACP → HubAgent 内部事件。
 *
 * 映射原则（ARCHITECTURE §7.1）：
 *   - 一类 ACP update 对应一类内部事件；
 *   - 每条事件都带 `raw`，便于回放与排障，不丢协议字段（注：写入 transcript 文件时会痦身，
 *     见 `runtime/acp-transcript.ts`；内存里的事件和推给 UI 的仍是带 raw 的原始版）；
 *   - 未知/新增 update 不丢弃，统一进 `session.notice`，避免版本升级时静默失明。
 */

export type AcpExecutionEvent =
  | {
      kind: 'initialized'
      protocolVersion: number
      agentInfo?: Implementation | null
      agentCapabilities?: AgentCapabilities
    }
  | { kind: 'session.created'; sessionId: string }
  | {
      kind: 'message.delta'
      role: 'agent' | 'thought' | 'user'
      text: string
      messageId?: string
      raw: SessionUpdate
    }
  | {
      kind: 'tool.call'
      toolCallId: string
      title: string
      status?: string
      toolKind?: string
      raw: SessionUpdate
    }
  | {
      kind: 'tool.call.update'
      toolCallId: string
      status?: string
      title?: string
      raw: SessionUpdate
    }
  | { kind: 'plan.updated'; entries: PlanEntry[]; raw: SessionUpdate }
  | {
      kind: 'permission.requested'
      sessionId: string
      toolCall: ToolCallUpdate
      options: PermissionOption[]
      decision: 'allow' | 'deny' | 'cancelled'
      optionId?: string
    }
  | { kind: 'session.notice'; sessionUpdate: string; raw: SessionUpdate }
  | { kind: 'prompt.finished'; stopReason: string }
  | { kind: 'protocol.error'; message: string; code?: string }
  | {
      kind: 'process.exit'
      reason: string
      code: number | null
      signal: NodeJS.Signals | null
    }

export function mapSessionUpdate(update: SessionUpdate): AcpExecutionEvent {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk': {
      const role =
        update.sessionUpdate === 'agent_message_chunk'
          ? 'agent'
          : update.sessionUpdate === 'agent_thought_chunk'
            ? 'thought'
            : 'user'
      if (update.content.type !== 'text') {
        return {
          kind: 'session.notice',
          sessionUpdate: `${update.sessionUpdate}:${update.content.type}`,
          raw: update,
        }
      }
      return {
        kind: 'message.delta',
        role,
        text: update.content.text,
        ...(update.messageId === undefined || update.messageId === null
          ? {}
          : { messageId: update.messageId }),
        raw: update,
      }
    }

    case 'tool_call':
      return {
        kind: 'tool.call',
        toolCallId: update.toolCallId,
        title: update.title,
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.kind === undefined ? {} : { toolKind: update.kind }),
        raw: update,
      }

    case 'tool_call_update':
      return {
        kind: 'tool.call.update',
        toolCallId: update.toolCallId,
        ...(update.status === undefined || update.status === null ? {} : { status: update.status }),
        ...(update.title === undefined || update.title === null ? {} : { title: update.title }),
        raw: update,
      }

    case 'plan':
      return { kind: 'plan.updated', entries: update.entries, raw: update }

    default:
      return {
        kind: 'session.notice',
        sessionUpdate: update.sessionUpdate,
        raw: update,
      }
  }
}

export function permissionEvent(
  request: RequestPermissionRequest,
  decision: 'allow' | 'deny' | 'cancelled',
  optionId?: string,
): AcpExecutionEvent {
  return {
    kind: 'permission.requested',
    sessionId: request.sessionId,
    toolCall: request.toolCall,
    options: request.options,
    decision,
    ...(optionId === undefined ? {} : { optionId }),
  }
}
