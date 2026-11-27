import { readFileSync } from 'node:fs'
import type { MutualTlsMaterial } from '../adapters/a2a/mtls'
import type { RemotePeerSummary } from '../brain/types'
import { HubError } from '../shared/errors'
import type { PeerEndpoint, ResolvePeerEndpoint } from './remote-dispatch'

/**
 * 出站对端注册表（A3 生产接线）。
 *
 * 两个用途：
 * 1. 给 Brain 看“能委托给谁”（`peers`，只含 id / 名字 / 能力）；
 * 2. 给 Runtime 在**执行时**解析连接信息（`resolvePeer`，含 token 与证书）。
 *
 * token 与证书只在配置里、只在执行时读取，**不进数据库、不进派发 payload**。
 */

export interface RemotePeerConfig {
  id: string
  displayName: string
  url: string
  token?: string
  capabilities?: unknown
  tls?: {
    certFile: string
    keyFile: string
    caFile?: string
    serverName?: string
  }
}

export interface RemotePeerRegistry {
  /** 供 Brain 快照使用的最小信息。 */
  peers: RemotePeerSummary[]
  resolvePeer: ResolvePeerEndpoint
}

/**
 * 构建注册表。TLS 证书**启动时**一次性读取：文件缺失就在启动期失败，
 * 而不是等到真正委托时才炸（fail-fast，和 A2A 监听面的处理一致）。
 */
export function loadRemotePeers(entries: readonly RemotePeerConfig[]): RemotePeerRegistry {
  const endpoints = new Map<string, PeerEndpoint>()
  const peers: RemotePeerSummary[] = []

  for (const entry of entries) {
    if (endpoints.has(entry.id)) {
      throw new HubError('CONFIG_INVALID', `remotePeers 的 id 重复：${entry.id}`)
    }
    if (entry.token === undefined && entry.tls === undefined) {
      /* 既没有 token 也没有证书 → 连身份都证明不了，直接判配置错误。 */
      throw new HubError('CONFIG_INVALID', `remotePeers「${entry.id}」必须至少配置 token 或 tls`)
    }

    const tls: MutualTlsMaterial | undefined =
      entry.tls === undefined
        ? undefined
        : {
            cert: readPem(entry.tls.certFile, entry.id),
            key: readPem(entry.tls.keyFile, entry.id),
            ...(entry.tls.caFile === undefined ? {} : { ca: readPem(entry.tls.caFile, entry.id) }),
            ...(entry.tls.serverName === undefined ? {} : { serverName: entry.tls.serverName }),
          }

    endpoints.set(entry.id, {
      url: entry.url,
      ...(entry.token === undefined ? {} : { token: entry.token }),
      ...(tls === undefined ? {} : { tls }),
    })
    peers.push({
      id: entry.id,
      displayName: entry.displayName,
      ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
    })
  }

  return {
    peers,
    resolvePeer: (peerId) => endpoints.get(peerId),
  }
}

function readPem(path: string, peerId: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HubError('CONFIG_INVALID', `remotePeers「${peerId}」的证书文件读不到：${path}`, {
      path,
      message,
    })
  }
}
