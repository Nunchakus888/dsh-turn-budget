import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as TurnBudget from '../src/index.js'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(calls: Array<{ id: string; name: string }>): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, call] of calls.entries()) {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: CallId(call.id), name: call.name, argumentsDelta: '{}' },
      {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: CallId(call.id), name: call.name, arguments: '{}' },
      },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function harness(config: TurnBudget.Config, script: StreamChunk[][]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TurnBudget, config)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('budget-test'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent }
}

function start(agent: Awaited<ReturnType<typeof harness>>['agent']): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'run' }],
    source: { kind: 'user' },
  }))
}

describe('turn budget integration', () => {
  it('rejects the proposed step after the configured request count', async () => {
    const { ctx, adapter, agent } = await harness(
      { maxStepsPerTurn: 2 },
      [toolResponse([{ id: 'c1', name: 'probe' }]), toolResponse([{ id: 'c2', name: 'probe' }])],
    )
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    start(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'blocked' } } })
    await ctx.fiber.dispose()
  })

  it('denies tool executions beyond the per-turn limit and preserves one final model step', async () => {
    const { ctx, adapter, agent } = await harness(
      { maxToolCallsPerTurn: 1, maxStepsPerTurn: 3 },
      [toolResponse([{ id: 'c1', name: 'probe' }, { id: 'c2', name: 'probe' }]), textResponse('done')],
    )
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {}, async execute() {
        executions += 1
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    start(agent)
    await agent.whenIdle()

    expect(executions).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    const failures = agent.session.events.filter(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'tool-result'
        && block.isError
        && block.content.some(content => content.type === 'text' && content.text.includes('turn budget exceeded'))))
    expect(failures).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('resets the tool-call allowance at the next turn boundary', async () => {
    const { ctx, adapter, agent } = await harness(
      { maxToolCallsPerTurn: 1, maxStepsPerTurn: 2 },
      [
        toolResponse([{ id: 'c1', name: 'probe' }]),
        textResponse('first turn done'),
        toolResponse([{ id: 'c2', name: 'probe' }]),
        textResponse('second turn done'),
      ],
    )
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {}, async execute() {
        executions += 1
        return [{ type: 'text', text: 'ok' }]
      },
    }))

    start(agent)
    await agent.whenIdle()
    start(agent)
    await agent.whenIdle()

    expect(executions).toBe(2)
    expect(adapter.requests).toHaveLength(4)
    expect(agent.session.events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('stops before another request once exact provider usage reaches the token ceiling', async () => {
    const { ctx, adapter, agent } = await harness(
      { maxProviderTokensPerTurn: 15 },
      [toolResponse([{ id: 'c1', name: 'probe' }])],
    )
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    start(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(TurnBudget.providerTokensForTurn(agent.session.events, 1)).toBe(15)
    await ctx.fiber.dispose()
  })
})

describe('pure accounting', () => {
  it('uses the final message usage instead of double-counting its earlier usage chunk', () => {
    const session = Session.create(SessionId('usage'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const usageSeq = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    }).seq
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 2 },
    }, { surfaceOp: 'append', sourceEventSeqs: [usageSeq] })

    expect(TurnBudget.providerTokensForTurn(session.events, 1)).toBe(14)
  })

  it('rejects an inert or invalid policy at load time', () => {
    expect(() => TurnBudget.validateConfig({})).toThrow('configure at least one')
    expect(() => TurnBudget.validateConfig({ maxStepsPerTurn: 0 })).toThrow('positive safe integer')
    expect(() => TurnBudget.validateConfig({ maxToolCallsPerTurn: 1.5 })).toThrow('positive safe integer')
  })
})
