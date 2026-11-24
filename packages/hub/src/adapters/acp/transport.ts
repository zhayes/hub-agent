import { ReadableStream, WritableStream } from 'node:stream/web'
import { TextDecoder, TextEncoder } from 'node:util'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import type { AgentExit, AgentProcess, AgentProcessEvent } from '../../agent-host/types'
import { HubError } from '../../shared/errors'

/**
 * AgentHost 的 line-oriented stdio → ACP NDJSON Stream。
 *
 * 分工：
 *   - AgentHost 负责按行切 stdout / stderr（含粘包、跨 chunk 的半行）；
 *   - 这里只把 stdout 行转成字节流交给官方 SDK，stderr 走独立回调，绝不混入协议；
 *   - 写方向做行缓冲 + `writeLineAsync` 背压等待。
 */

export interface AcpTransportOptions {
  onStderr?: (line: string) => void
  onExit?: (exit: AgentExit) => void
  onProtocolError?: (error: HubError) => void
  maxMessageBytes?: number
}

export interface AcpTransport {
  stream: Stream
  close(): void
}

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024

export function createAcpTransport(
  process: AgentProcess,
  options: AcpTransportOptions = {},
): AcpTransport {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES

  let stdoutDone = false
  let unsubscribe: (() => void) | undefined

  const failProtocol = (message: string): void => {
    const error = new HubError('ADAPTER_INCOMPATIBLE', message)
    options.onProtocolError?.(error)
  }

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (stdoutDone) return
        stdoutDone = true
        try {
          controller.close()
        } catch {
          // 已被取消/关闭
        }
      }

      unsubscribe = process.onEvent((event: AgentProcessEvent) => {
        if (event.type === 'stdout') {
          const bytes = encoder.encode(`${event.line}\n`)
          if (bytes.byteLength > maxMessageBytes) {
            failProtocol(`ACP 单条消息超过 ${maxMessageBytes} 字节`)
            try {
              controller.error(new Error('ACP message too large'))
            } catch {
              // 已关闭
            }
            return
          }
          if (stdoutDone) return
          try {
            controller.enqueue(bytes)
          } catch {
            // 消费者已取消；忽略剩余 stdout
          }
          return
        }
        if (event.type === 'stderr') {
          options.onStderr?.(event.line)
          return
        }
        if (event.type === 'exit') {
          options.onExit?.(event.exit)
          close()
        }
      })

      if (process.exit !== undefined) close()
    },
    cancel() {
      unsubscribe?.()
    },
  })

  let outbound = ''
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      outbound += decoder.decode(chunk, { stream: true })
      let newline = outbound.indexOf('\n')
      while (newline >= 0) {
        const line = outbound.slice(0, newline).replace(/\r$/, '')
        outbound = outbound.slice(newline + 1)
        if (line.length > 0) {
          if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) {
            throw new HubError(
              'ADAPTER_INCOMPATIBLE',
              `发送的 ACP 消息超过 ${maxMessageBytes} 字节`,
            )
          }
          await process.writeLineAsync(line)
        }
        newline = outbound.indexOf('\n')
      }
    },
    async close() {
      if (outbound.length > 0) {
        await process.writeLineAsync(outbound)
        outbound = ''
      }
    },
  })

  return {
    stream: ndJsonStream(writable, readable, { maxMessageBytes }),
    close(): void {
      unsubscribe?.()
    },
  }
}
