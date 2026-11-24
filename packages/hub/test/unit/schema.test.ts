import { describe, expect, it } from 'vitest'
import { domainEventSchema, executionSchema, taskSchema } from '../../src/domain/schema'
import { AT, IDS, task as taskFixture } from './domain-fixtures'

describe('实体 schema', () => {
  it('接受合法 task，并保留品牌化 id', () => {
    const parsed = taskSchema.parse(taskFixture)
    expect(parsed.id).toBe('t1')
    expect(parsed.status).toBe('ready')
  })

  it('拒绝未知状态', () => {
    const result = taskSchema.safeParse({ ...taskFixture, status: 'done' })
    expect(result.success).toBe(false)
  })

  it('拒绝缺少必填字段', () => {
    const { acceptanceCriteria: _dropped, ...withoutCriteria } = taskFixture
    const result = taskSchema.safeParse(withoutCriteria)
    expect(result.success).toBe(false)
  })

  it('execution 要求 attempt >= 1', () => {
    const result = executionSchema.safeParse({
      id: IDS.e1,
      taskId: IDS.task,
      subtaskId: IDS.s1,
      agentId: IDS.agent,
      status: 'created',
      attempt: 0,
      createdAt: AT,
    })
    expect(result.success).toBe(false)
  })
})

describe('事件 schema', () => {
  it('解析 task.status 事件', () => {
    const parsed = domainEventSchema.parse({
      type: 'task.status',
      taskId: IDS.task,
      to: 'running',
      at: AT,
    })
    expect(parsed.type).toBe('task.status')
  })

  it('拒绝非法的迁移目标值（结构校验层）', () => {
    const result = domainEventSchema.safeParse({
      type: 'task.status',
      taskId: IDS.task,
      to: 'done',
      at: AT,
    })
    expect(result.success).toBe(false)
  })

  it('拒绝未知事件类型', () => {
    const result = domainEventSchema.safeParse({ type: 'task.exploded', taskId: 't1' })
    expect(result.success).toBe(false)
  })

  it('解析带证据的执行事件', () => {
    const parsed = domainEventSchema.parse({
      type: 'execution.evidence',
      executionId: IDS.e1,
      evidence: { commitSha: 'abc', changedFiles: ['a.ts'] },
    })
    expect(parsed.type).toBe('execution.evidence')
  })
})
