import { request as httpsRequest, type RequestOptions } from 'node:https'
import { Readable } from 'node:stream'

/**
 * 客户端证书材料（出站 mTLS）。
 *
 * `cert` / `key` 是 PEM；`ca` 是校验对端服务端证书用的受信 CA。
 * `serverName` 只在需要覆盖 SNI/校验名时给（例如经 Relay 转发）。
 */
export interface MutualTlsMaterial {
  cert: string | Buffer
  key: string | Buffer
  ca?: string | Buffer | ReadonlyArray<string | Buffer>
  serverName?: string
}

/**
 * 基于 `node:https` 的 fetch 实现，用来携带客户端证书（mTLS）。
 *
 * 为什么不引 undici：Node 的全局 `fetch` 只接受 undici dispatcher 才能带客户端证书，
 * 而 undici 不是本项目依赖。SDK 只用 `fetch` 的少数能力（POST JSON、读 `.ok/.status/
 * .text()/.json()`、以及流式 SSE 的 `.body`），这些用标准库就能完整覆盖：
 * 返回一个真正的 `Response` 对象，所以 SDK 无需任何改动。
 */
export function createMutualTlsFetch(material: MutualTlsMaterial): typeof fetch {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = toUrl(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = toBuffer(init?.body)
    if (body !== undefined) headers.set('content-length', String(body.byteLength))

    const servername = material.serverName ?? url.hostname
    const requestOptions: RequestOptions = {
      hostname: url.hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      cert: material.cert,
      key: material.key,
      ...(material.ca === undefined
        ? {}
        : { ca: material.ca as string | Buffer | Array<string | Buffer> }),
      /* SNI 不能是 IP 字面量，否则 Node 会报错；IP 场景只靠 SAN 校验。 */
      ...(isIpLiteral(servername) ? {} : { servername }),
    }
    const result = await new Promise<NodeResponse>((resolve, reject) => {
      const req = httpsRequest(requestOptions, (res) => {
        resolve({
          statusCode: res.statusCode ?? 502,
          statusMessage: res.statusMessage,
          rawHeaders: res.rawHeaders,
          stream: res,
        })
      })
      req.on('error', reject)

      const signal = init?.signal
      if (signal !== null && signal !== undefined) {
        if (signal.aborted) {
          req.destroy(new Error('请求已取消'))
          return
        }
        signal.addEventListener('abort', () => req.destroy(new Error('请求已取消')), { once: true })
      }

      if (body !== undefined) req.write(body)
      req.end()
    })

    const responseHeaders = new Headers()
    for (let i = 0; i + 1 < result.rawHeaders.length; i += 2) {
      responseHeaders.append(result.rawHeaders[i] as string, result.rawHeaders[i + 1] as string)
    }

    /* 204/304 不允许带 body；HEAD 也没有。其余原样流式转发（SSE 依赖这个）。 */
    const noBody = method === 'HEAD' || result.statusCode === 204 || result.statusCode === 304
    const stream = noBody ? null : (Readable.toWeb(result.stream) as ReadableStream<Uint8Array>)

    return new Response(stream, {
      status: result.statusCode,
      ...(result.statusMessage === undefined ? {} : { statusText: result.statusMessage }),
      headers: responseHeaders,
    })
  }
}

interface NodeResponse {
  statusCode: number
  statusMessage?: string
  rawHeaders: string[]
  stream: Readable
}

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

function toBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new Error('mTLS fetch 只支持字符串或字节类型的请求体')
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}
