import { createBrainFromEnv } from '../../src/brain/create-brain'
import { buildBrainInput } from '../../src/brain/snapshot'
import { type BrainInput, DEFAULT_BRAIN_BUDGET } from '../../src/brain/types'
import { validateBrainActions } from '../../src/brain/validate'
import { asGoalId, asTimestamp } from '../../src/domain/ids'
import { applyEvent, emptyState } from '../../src/domain/machine'

/**
 * 真实 Brain smoke（需要 key，不进 CI）：
 *   HUBAGENT_BRAIN_API_KEY=... pnpm test:brain-real
 */
function snapshot(): BrainInput {
  const at = asTimestamp(new Date().toISOString())
  const outcome = applyEvent(emptyState, {
    type: 'goal.created',
    goal: {
      id: asGoalId('smoke-goal'),
      userId: 'local',
      title: '给 README 加一行说明',
      intent: '给 README 加一行说明，只改 README',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  })
  if (!outcome.ok) throw new Error(outcome.error.message)
  return buildBrainInput({
    state: outcome.state,
    goalId: 'smoke-goal',
    agents: [{ id: 'agent-smoke', name: 'smoke', status: 'online' }],
    pending: [],
    budget: DEFAULT_BRAIN_BUDGET,
    stateVersion: 1,
  })
}

async function main(): Promise<void> {
  if (!process.env.HUBAGENT_BRAIN_API_KEY?.trim()) {
    process.stdout.write(
      'SKIP: 需要 HUBAGENT_BRAIN_API_KEY；可选 HUBAGENT_BRAIN_BASE_URL / MODEL\n',
    )
    return
  }
  const input = snapshot()
  const brain = createBrainFromEnv()
  const actions = await brain.step(input)
  const validation = validateBrainActions(input, actions, DEFAULT_BRAIN_BUDGET)
  process.stdout.write(
    `${JSON.stringify({ actions, validation, rationales: await brain.explain(input) }, null, 2)}\n`,
  )
  if (!validation.ok || validation.actions.length === 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
