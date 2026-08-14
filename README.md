# dsh-turn-budget

[![CI](https://github.com/Nunchakus888/dsh-turn-budget/actions/workflows/ci.yml/badge.svg)](https://github.com/Nunchakus888/dsh-turn-budget/actions/workflows/ci.yml)

`dsh-turn-budget` is a fail-closed resource governor for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It limits model steps, root and nested tool executions, and exact provider-reported token usage independently for every Agent turn.

The plugin uses public Harness extension points only:

- `agent/pre-step` rejects a model request that would exceed the step or provider-token ceiling.
- `tools/pre-execute` denies a tool body before dispatch when the turn has consumed its tool-call allowance.
- Existing `tool/result` and `turn/end` records preserve the resulting policy outcome in the canonical Session log.

This is a circuit breaker, not a billing system. It does not estimate currency, rewrite tool arguments, replace sandboxing or approvals, or terminate an uncooperative model/tool operation in the middle of a step.

## Install from a checkout

```sh
git clone https://github.com/Nunchakus888/dsh-turn-budget.git
dsh plugin --profile web add ./dsh-turn-budget
dsh --profile web --dump-config
dsh --profile web
```

The bundled profile layer enables a conservative baseline of 24 model steps and 40 tool executions per turn. Override the complete row in the profile's `cordis.patch.yml` when a deployment needs different ceilings:

```yaml
- update:
    id: turn-budget
    config:
      maxStepsPerTurn: 16
      maxToolCallsPerTurn: 32
      maxProviderTokensPerTurn: 250000
```

Every configured limit must be a positive safe integer. At least one limit is required.

## Enforcement semantics

| Limit | Enforcement point | Counted work | Outcome |
|---|---|---|---|
| `maxStepsPerTurn` | Before the next model request | Entered requests in the current turn | The proposed step is rejected; the turn closes as `blocked`. |
| `maxToolCallsPerTurn` | Before each tool body | Root calls plus Code Mode/nested dispatches carrying the Agent | Excess calls return a policy error naming the exceeded budget; the model retains one opportunity to finish without another tool. |
| `maxProviderTokensPerTurn` | Before the next model request | Latest provider usage per step, including cache read/write buckets | The proposed step is rejected after the reported total reaches the ceiling. |

Token enforcement is exact only when the provider reports usage. Missing provider usage is not estimated. A provider can exceed the configured ceiling inside its current response; the plugin prevents the following request because the public lifecycle exposes no preemptive token stream budget.

The tool ledger is process-local and keyed by live Agent identity. Cold recovery closes interrupted turns before they can continue, so a process restart cannot resume an old in-flight ledger.

## Development

```sh
pnpm install
pnpm run check
```

The integration tests boot the real Agent Loop with the published Harness testkit. They cover step rejection, pre-dispatch tool denial, per-turn reset, final-response allowance, provider-token accounting, and duplicate usage replacement.

## License

MIT
