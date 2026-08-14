/**
 * Fail-closed per-turn resource budgets for DeepSeek Harness.
 *
 * @module dsh-turn-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'turn-budget'

/** Resource ceilings enforced independently for every Agent turn. */
export interface Config {
  /** Maximum model requests admitted in one turn. */
  maxStepsPerTurn?: number
  /** Maximum root and nested tool executions admitted in one turn. */
  maxToolCallsPerTurn?: number
  /** Maximum provider-reported tokens consumed before another model request is admitted. */
  maxProviderTokensPerTurn?: number
}

export const Config: Schema<Config> = Schema.object({
  maxStepsPerTurn: Schema.number(),
  maxToolCallsPerTurn: Schema.number(),
  maxProviderTokensPerTurn: Schema.number(),
})

/** One active turn's process-local tool admission ledger. */
interface TurnLedger {
  turn: number
  admittedToolCalls: number
}

/** Exact disjoint total reported by one provider usage record. */
function usageTotal(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** Return the currently open turn, or undefined outside a turn. */
export function openTurn(events: readonly SessionEvent[]): number | undefined {
  const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return boundary?.type === 'turn/start' ? boundary.data.turn : undefined
}

/**
 * Sum provider usage for one turn without double-counting usage chunks and the
 * final assistant message. The newest record for each step is authoritative.
 */
export function providerTokensForTurn(events: readonly SessionEvent[], turn: number): number {
  const usageByStep = new Map<number, TokenUsage>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start' && event.data.turn === turn) break
    if (event.type === 'assistant/chunk'
      && event.data.turn === turn
      && event.data.chunk.type === 'usage'
      && !usageByStep.has(event.data.step)) {
      usageByStep.set(event.data.step, event.data.chunk.usage)
      continue
    }
    if (event.type === 'assistant/message'
      && event.data.turn === turn
      && event.data.usage !== undefined
      && !usageByStep.has(event.data.step)) {
      usageByStep.set(event.data.step, event.data.usage)
    }
  }
  let total = 0
  for (const usage of usageByStep.values()) total += usageTotal(usage)
  return total
}

/** Reject zero, fractional, or unsafe limits before the plugin registers listeners. */
function validateLimit(pluginName: string, field: keyof Config, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${pluginName}: ${field} must be a positive safe integer`)
  }
}

/** Require at least one active ceiling so a mounted policy cannot silently do nothing. */
export function validateConfig(config: Config): void {
  validateLimit(name, 'maxStepsPerTurn', config.maxStepsPerTurn)
  validateLimit(name, 'maxToolCallsPerTurn', config.maxToolCallsPerTurn)
  validateLimit(name, 'maxProviderTokensPerTurn', config.maxProviderTokensPerTurn)
  if (config.maxStepsPerTurn === undefined
    && config.maxToolCallsPerTurn === undefined
    && config.maxProviderTokensPerTurn === undefined) {
    throw new Error(`${name}: configure at least one turn budget`)
  }
}

/** Install step, token, and tool-call admission gates. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  const ledgers = new WeakMap<Agent, TurnLedger>()

  function ledgerFor(agent: Agent, turn: number): TurnLedger {
    const current = ledgers.get(agent)
    if (current?.turn === turn) return current
    const created = { turn, admittedToolCalls: 0 }
    ledgers.set(agent, created)
    return created
  }

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
    if (config.maxStepsPerTurn !== undefined && step > config.maxStepsPerTurn) {
      return { kind: 'reject' }
    }
    if (config.maxProviderTokensPerTurn !== undefined
      && providerTokensForTurn(agent.session.events, turn) >= config.maxProviderTokensPerTurn) {
      return { kind: 'reject' }
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const { agent } = exec
    if (agent === undefined || config.maxToolCallsPerTurn === undefined) return next()
    const turn = openTurn(agent.session.events)
    if (turn === undefined) return next()
    const ledger = ledgerFor(agent, turn)
    if (ledger.admittedToolCalls >= config.maxToolCallsPerTurn) {
      return {
        kind: 'deny',
        reason: `turn budget exceeded: at most ${config.maxToolCallsPerTurn} tool calls are allowed in turn ${turn}`,
      }
    }
    ledger.admittedToolCalls += 1
    return next()
  })
}
