# Downstream plugins cannot safely persist their own Session events

## Summary

DeepSeek Harness explicitly encourages out-of-tree plugins, and `SessionEventMap` is declaration-merge extensible. A downstream plugin can therefore compile a call such as `session.append('budget/exceeded', data)`. The resulting Session cannot be loaded again through the standard persistence coordinator, however, because the event type is absent from the repository-generated `KNOWN_SESSION_EVENT_TYPES` and `Session.append()` exposes no way to set the envelope's `ignorable: true` marker.

This leaves external plugins with two choices: avoid durable domain events, or write a Session that the next Harness process refuses to open.

Audited at commit `47f943859bef60e4160492346772ded9b24f765a` and npm release `0.1.0-rc.6`.

## Concrete consumer

`dsh-turn-budget` is an out-of-tree policy plugin using the public `agent/pre-step` and `tools/pre-execute` extension points. Step and token ceilings need a durable, log-only receipt naming the applied limit, observed usage, and enforcement point. That receipt is informational: a Harness build without the plugin may skip it safely because `turn/end` and `tool/result` already preserve the canonical execution outcome.

The plugin currently omits that receipt because appending it would make the persisted Session unloadable.

## Reproduction

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'budget/exceeded': {
      turn: number
      limit: 'steps' | 'tool-calls' | 'provider-tokens'
      configured: number
      observed: number
    }
  }
}

session.append('budget/exceeded', {
  turn: 1,
  limit: 'steps',
  configured: 24,
  observed: 25,
})
await ctx.sessions.flush(session)

// In a fresh process, the standard persistence load refuses:
await ctx.sessions.load(session.id)
// SessionFormatUnsupportedError: event type "budget/exceeded" ...
// unknown to this harness and not marked ignorable
```

The refusal is internally consistent:

- `packages/core/session/src/known-event-types.ts` states that downstream events are outside the generated set and that a registration surface is deferred until a consumer exists.
- `packages/session/session-persistence/src/coordinator.ts` rejects every unknown type without `ignorable: true`.
- `SessionEvent` publicly declares `ignorable?: true`.
- `Session.append()` accepts surface metadata only for surface events and no options for log-only events, so a downstream producer cannot set the marker through the supported write API.

## Expected behavior

An out-of-tree plugin should have a supported way to write a log-only event with explicit forward-compatibility semantics:

1. Informational events can be appended with `ignorable: true`, allowing Harness to load the Session when the plugin is absent.
2. Required events can register their type before Session restoration, allowing persistence to accept them only while the owning plugin is present.
3. Surface events remain repository-owned because skipping an unknown surface operation could reconstruct different model history.

## Minimal API direction

The smallest useful first step is an append option restricted to downstream log-only event types:

```ts
session.append('budget/exceeded', data, { ignorable: true })
```

A complete required-event path can add an effect-scoped registry later:

```ts
ctx.sessionEventTypes.register('memory/changed')
```

The persistence coordinator would accept the generated repository vocabulary plus currently registered downstream types. Removing the plugin would restore fail-closed loading for its required events. Registration must activate before Session restoration and unwind with the plugin fiber.

## Why this matters

Durable domain state is a core extension path in the architecture, while the contribution guide directs external code into independent plugins. Closing this gap enables ecosystem plugins for budgets, memory, workflow audit, evaluation, and governance without weakening the existing unknown-event refusal rule.
