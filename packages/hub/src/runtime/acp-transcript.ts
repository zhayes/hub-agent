import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AcpExecutionEvent } from '../adapters/acp/event'

/**
 * transcript 落盘前的瘦身。
 *
 * 实测一次 review 回合：2 分 21 秒里 6857 条 `session/update`，落盘 7.88 MB，
 * 其中真正的内容不到 1 MB —— 其余是协议层重复：
 *
 * | 浪费 | 体积 | 处理 |
 * |---|---|---|
 * | `raw._meta`（每帧都带的 provider 遥测：messageId/requestId/traceId/模型名） | 3.16 MB | 丢掉 |
 * | `message.delta` 的 `raw`（与事件本身的 `text` 完全等价） | 1.87 MB | 丢掉 |
 * | `tool.call.update` 的 `rawInput`（输入在 `tool.call` 上已有一份，更新里是流式增长的中间态） | 1.87 MB | 丢掉 |
 *
 * 瘦身只作用于**落盘副本**：`onEvent` 推给 UI 的仍是原始事件，
 * 排障需要的语义字段（kind / text / toolCallId / status / content / entries）全部保留。
 *
 * 真需要完整协议报文时，从 Agent 自己的日志取——transcript 只负责回答
 * “这一步发生了什么”。
 */
export function slimTranscriptEvent(event: AcpExecutionEvent): AcpExecutionEvent {
  switch (event.kind) {
    case 'message.delta':
      return withoutRaw(event)
    case 'tool.call':
    case 'plan.updated':
    case 'session.notice':
      return { ...event, raw: stripRaw(event.raw, false) } as AcpExecutionEvent
    case 'tool.call.update':
      return { ...event, raw: stripRaw(event.raw, true) } as AcpExecutionEvent
    default:
      return event
  }
}

/** 不修改传入事件：状态机/UI 可能还要用原始对象。 */
function withoutRaw(event: AcpExecutionEvent): AcpExecutionEvent {
  const copy: Record<string, unknown> = { ...event }
  delete copy['raw']
  return copy as unknown as AcpExecutionEvent
}

function stripRaw(raw: SessionUpdate, dropInput: boolean): SessionUpdate {
  const copy: Record<string, unknown> = { ...(raw as unknown as Record<string, unknown>) }
  delete copy['_meta']
  if (dropInput) delete copy['rawInput']
  return copy as unknown as SessionUpdate
}
