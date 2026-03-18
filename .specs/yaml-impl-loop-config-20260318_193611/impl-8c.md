# Task 8c Implementation Summary — Phase Runner Tests

## What was done

Added 7 new `it` cases inside the existing `"execute - IMPLEMENTATION phase with IImplementationLoop (task 5.2)"` describe block in `orchestrator-ts/tests/domain/phase-runner.test.ts`.

## Tests added

1. **`phaseDef.loopPhases` threaded into `implementationLoop.run` options** — creates a `makeFrameworkDef({ loopPhases })`, verifies the second argument passed to `loop.run` contains the same `loopPhases` reference.

2. **Absent `phaseDef.loopPhases` → `run` called without `loopPhases`** — uses `makeFrameworkDef()` with no args, asserts `optionsArg.loopPhases` is `undefined`.

3. **YAML `loopPhases` wins when DI options also has `loopPhases`** — passes both `yamlLoopPhases` via `makeFrameworkDef` and `diLoopPhases` via `implementationLoopOptions`, asserts the captured options contain the YAML value (spread-last precedence).

4. **`ctx.specDir` threaded as `specDir`** — asserts `optionsArg.specDir === ctx.specDir` (`.kiro/specs/my-spec`).

5. **`ctx.language` threaded as `language`** — asserts `optionsArg.language === ctx.language` (`"en"`).

6. **`this.sdd` threaded as `sdd`** — passes a named `sdd` adapter, asserts `optionsArg.sdd === sdd` (same reference).

7. **`this.llm` threaded as `llm`** — passes a named `llm` provider, asserts `optionsArg.llm === llm` (same reference).

## Approach

Each test captures the second argument to `loop.run` via `mock.calls[0][1]`, then asserts the specific field. This avoids asserting the entire merged options object (which would make tests brittle) and instead pinpoints the field being tested.

## Verification

```
bun test tests/domain/phase-runner.test.ts
44 pass, 0 fail
```

All 7 new tests pass. No existing tests broken (total went from 37 to 44).
