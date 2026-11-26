import type { AgentCard } from '@a2a-js/sdk'
import { A2A_ERROR_CODE, VersionNotSupportedError } from '@a2a-js/sdk/errors'
import { getSupportedVersions, validateVersion } from '@a2a-js/sdk/server'
import { describe, expect, it } from 'vitest'

/**
 * ADR 0028 的导入冒烟：官方 SDK 能在本仓库 strict tsconfig 下解析，
 * 且它自带的版本校验与错误码就是规范那一套（不是我们自定义的字符串）。
 *
 * 这不是“测第三方库”，而是锁住我们的**适配假设**：
 * 一旦 SDK 升级改了版本校验语义或错误码，这里先红。
 */
function card(): AgentCard {
  return {
    name: 'hubagent-test',
    description: '协议冒烟用',
    supportedInterfaces: [
      {
        url: 'https://127.0.0.1:8443/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
    ],
    provider: undefined,
    version: '0.0.0-test',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
    signatures: [],
  }
}

describe('A2A 协议层：官方 SDK 的适配假设（ADR 0028）', () => {
  it('锁定的 JSONRPC binding 声明支持 1.0', () => {
    expect([...getSupportedVersions(card())]).toContain('1.0')
  })

  it('1.0 通过校验、0.5 被拒（返回规范错误类型）', () => {
    expect(() => validateVersion('1.0', card())).not.toThrow()
    expect(() => validateVersion('0.5', card())).toThrow(VersionNotSupportedError)
  })

  it('错误码是规范那一套（-32001..-32009），可直接用于 PRD §7.6.3 映射', () => {
    expect(A2A_ERROR_CODE.TASK_NOT_FOUND).toBe(-32001)
    expect(A2A_ERROR_CODE.TASK_NOT_CANCELABLE).toBe(-32002)
    expect(A2A_ERROR_CODE.UNSUPPORTED_OPERATION).toBe(-32004)
    expect(A2A_ERROR_CODE.VERSION_NOT_SUPPORTED).toBe(-32009)
  })
})
