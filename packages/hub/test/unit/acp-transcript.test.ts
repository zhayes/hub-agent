import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import type { AcpExecutionEvent } from '../../src/adapters/acp/event'
import { slimTranscriptEvent } from '../../src/runtime/acp-transcript'

const meta = { 'codebuddy.ai/traceId': 't-1', 'codebuddy.ai/messageId': 'm-1' }

function rawWith(extra: Record<string, unknown>): SessionUpdate {
  return {
    sessionUpdate: extra['sessionUpdate'] ?? 'tool_call_update',
    ...extra,
  } as unknown as SessionUpdate
}

describe('transcript 瘦身：只丢协议重复，保留语义', () => {
  it('message.delta：raw 整块丢掉，文本与 messageId 留在事件上', () => {
    const event: AcpExecutionEvent = {
      kind: 'message.delta',
      role: 'agent',
      text: 'hello',
      messageId: 'm-1',
      raw: rawWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
        _meta: meta,
      }),
    }

    const slim = slimTranscriptEvent(event)

    expect('raw' in slim).toBe(false)
    expect(slim.kind).toBe('message.delta')
    if (slim.kind === 'message.delta') {
      expect(slim.text).toBe('hello')
      expect(slim.messageId).toBe('m-1')
    }
    /* 原事件不能被改动：UI/状态机还可能读 raw。 */
    expect('raw' in event).toBe(true)
  })

  it('tool.call：丢 _meta，但保留 rawInput（工具输入的唯一一份）', () => {
    const event: AcpExecutionEvent = {
      kind: 'tool.call',
      toolCallId: 'c-1',
      title: 'Bash',
      raw: rawWith({
        sessionUpdate: 'tool_call',
        toolCallId: 'c-1',
        title: 'Bash',
        rawInput: { command: 'ls' },
        _meta: meta,
      }),
    }

    const slim = slimTranscriptEvent(event)
    if (slim.kind !== 'tool.call') throw new Error('kind 变了')

    const raw = slim.raw as unknown as Record<string, unknown>
    expect(raw['_meta']).toBeUndefined()
    expect(raw['rawInput']).toEqual({ command: 'ls' })
    expect(raw['title']).toBe('Bash')
  })

  it('tool.call.update：丢 _meta 与 rawInput（输入在上面那条已有），工具结果保留', () => {
    const event: AcpExecutionEvent = {
      kind: 'tool.call.update',
      toolCallId: 'c-1',
      status: 'completed',
      raw: rawWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c-1',
        status: 'completed',
        rawInput: { command: 'ls' },
        content: [{ type: 'content', content: { type: 'text', text: 'a.ts b.ts' } }],
        _meta: meta,
      }),
    }

    const slim = slimTranscriptEvent(event)
    if (slim.kind !== 'tool.call.update') throw new Error('kind 变了')

    const raw = slim.raw as unknown as Record<string, unknown>
    expect(raw['_meta']).toBeUndefined()
    expect(raw['rawInput']).toBeUndefined()
    expect(raw['content']).toBeDefined()
    expect(slim.status).toBe('completed')
  })

  it('plan.updated：只丢 _meta，条目不动', () => {
    const event: AcpExecutionEvent = {
      kind: 'plan.updated',
      entries: [{ content: 'step 1', priority: 'high', status: 'pending' }],
      raw: rawWith({
        sessionUpdate: 'plan',
        entries: [{ content: 'step 1', priority: 'high', status: 'pending' }],
        _meta: meta,
      }),
    }

    const slim = slimTranscriptEvent(event)
    if (slim.kind !== 'plan.updated') throw new Error('kind 变了')

    expect(slim.entries).toHaveLength(1)
    expect((slim.raw as unknown as Record<string, unknown>)['_meta']).toBeUndefined()
  })

  it('没有 raw 的事件原样返回', () => {
    const event: AcpExecutionEvent = { kind: 'prompt.finished', stopReason: 'end_turn' }
    expect(slimTranscriptEvent(event)).toBe(event)
  })
})
