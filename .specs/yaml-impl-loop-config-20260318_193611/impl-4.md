# Task 4 Implementation Summary — Threading in `phase-runner.ts`

## File Modified

`orchestrator-ts/src/application/services/workflow/phase-runner.ts`

## Change Description

Replaced the `case "implementation_loop":` branch body in `PhaseRunner.execute()` with the merged-options pattern defined in design Section 5.

### Merge order (spread precedence)

1. **Defaults from PhaseRunner's own fields** — `specDir: ctx.specDir`, `language: ctx.language`, `sdd: this.sdd`, `llm: this.llm`
2. **DI-provided options** — `...(this.implementationLoopOptions ?? {})` — overrides the defaults above
3. **YAML `loopPhases`** — `...(phaseDef.loopPhases !== undefined ? { loopPhases: phaseDef.loopPhases } : {})` — spread last so YAML always wins

`implementationLoop.run()` is called with `mergedOptions` when `Object.keys(mergedOptions).length > 0`, otherwise `undefined`. The existing result mapping (`completed → ok:true`, etc.) and the no-loop stub path are unchanged.

## Type Check Result

`bun run typecheck` reports one pre-existing error in `tests/application/memory-port.test.ts:173` (unrelated to this task). No new errors introduced by this change.
