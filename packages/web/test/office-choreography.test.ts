import { describe, expect, it } from 'vitest'
import type { SceneAgent } from '../src/features/agents/office/contracts'
import {
  isFinishing,
  moveTarget,
  phaseActions,
  poseOf,
} from '../src/features/agents/office/scene/choreography'

function sceneAgent(phase: SceneAgent['phase'], deskIndex?: number): SceneAgent {
  return {
    id: 'a1',
    name: 'Agent',
    phase,
    ...(deskIndex === undefined ? {} : { deskIndex }),
  }
}

describe('poseOf', () => {
  it('工位阶段坐姿；等待举手；暂停靠背', () => {
    expect(poseOf('working')).toEqual({ seated: true, hand: false, lean: false })
    expect(poseOf('needs-approval')).toMatchObject({ hand: true })
    expect(poseOf('needs-input')).toMatchObject({ hand: true })
    expect(poseOf('paused')).toMatchObject({ seated: true, lean: true })
    expect(poseOf('standby')).toMatchObject({ seated: true })
    expect(poseOf('off-floor')).toMatchObject({ seated: false })
  })
})

describe('moveTarget', () => {
  it('离场 → hide；待命 → bench；工位 → desk', () => {
    expect(moveTarget(sceneAgent('off-floor'))).toBe('hide')
    expect(moveTarget(sceneAgent('standby'))).toBe('bench')
    expect(moveTarget(sceneAgent('working', 0))).toBe('desk')
  })
})

describe('isFinishing', () => {
  it('从工位阶段回到待命/离场才算完成', () => {
    expect(isFinishing('working', 'standby')).toBe(true)
    expect(isFinishing('needs-approval', 'standby')).toBe(true)
    expect(isFinishing('standby', 'working')).toBe(false)
    expect(isFinishing(undefined, 'standby')).toBe(false)
  })
})

describe('phaseActions', () => {
  it('首次进场：enter + walk-desk + sit', () => {
    const actions = phaseActions(undefined, 'working')
    expect(actions).toContain('enter')
    expect(actions).toContain('walk-desk')
    expect(actions).toContain('sit')
  })

  it('空闲进场到 bench', () => {
    expect(phaseActions(undefined, 'standby')).toContain('walk-bench')
  })

  it('离场：stand + leave', () => {
    expect(phaseActions('working', 'off-floor')).toEqual(['stand', 'leave'])
  })

  it('等待授权 → 举手；恢复 → 放下', () => {
    expect(phaseActions('working', 'needs-approval')).toContain('raise-hand')
    expect(phaseActions('needs-approval', 'working')).toContain('lower-hand')
  })

  it('完成：盖章 + 折桌', () => {
    const actions = phaseActions('working', 'standby')
    expect(actions).toContain('stamp')
    expect(actions).toContain('fold-desk')
  })

  it('相同阶段没有动作（重复快照不产生新动画）', () => {
    expect(phaseActions('working', 'working')).toEqual([])
  })
})
