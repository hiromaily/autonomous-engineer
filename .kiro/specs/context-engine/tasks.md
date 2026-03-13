# Implementation Plan

- [ ] 1. Install dependency and define all application port types
- [x] 1.1 Add js-tiktoken to the orchestrator-ts package and verify it resolves synchronously
  - Add `js-tiktoken` to `orchestrator-ts/package.json` dependencies
  - Run `bun install` inside `orchestrator-ts/` and confirm the package resolves without WASM errors
  - Verify that `import { Tiktoken } from "js-tiktoken"` works in a quick smoke file
  - _Requirements: 3.1_

- [x] 1.2 (P) Define all shared types and the IContextEngine port in `application/ports/context.ts`
  - Declare `LayerId` union, `StepType` union, and all request/result value-object interfaces (`ContextBuildRequest`, `ContextAssemblyResult`, `ExpansionRequest`, `ExpansionResult`, `ToolResultEntry`, `LayerTokenUsage`)
  - Declare `PlannerDecision`, `LayerBudgetConfig`, `TokenBudgetConfig`, `LayerBudgetMap`, `CompressionTechnique`, `CompressionResult`, `AccumulatedEntry`, `ExpansionEvent`, `ContextAccumulatorConfig`, `CachedEntry`, `CacheStats`, `ContextAssemblyLog` types
  - Declare the `IContextEngine`, `IContextPlanner`, `ITokenBudgetManager`, `ILayerCompressor`, `IContextAccumulator`, `IContextCache` interfaces with full JSDoc
  - Ensure every method signature is `readonly`-safe and matches the contracts in design.md exactly
  - _Requirements: 1.1, 1.4, 2.5, 3.5, 4.5, 5.4, 5.5, 6.5, 9.1_

- [x] 2. Implement LayerRegistry
  - Define the seven ordered layer entries with their default token budgets and cacheable/compressible flags as a frozen constant in `domain/context/layer-registry.ts`
  - Expose a helper that returns layers in canonical order and a lookup by `LayerId`
  - Enforce the invariant that `systemInstructions` precedes `taskDescription` and `toolResults` is last
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 4.6_

- [x] 3. Implement ContextPlanner
  - Implement `IContextPlanner.plan()` as a pure function in `domain/context/context-planner.ts`; no I/O, no imports from application or adapter layers
  - For `Exploration` steps always include `codeContext` and `repositoryState` in `layersToRetrieve`
  - For `Modification` steps always include `codeContext` and `activeSpecification`
  - For `Validation` steps always include `toolResults` and `activeSpecification`
  - Always include `systemInstructions` and `taskDescription` regardless of step type; populate `memoryRetrieval` across all step types
  - Set `rationale` to `"stepType:${stepType} taskExcerpt:${taskDescription.slice(0, 100)}"` for every decision
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 4. Implement TokenBudgetManager
  - Implement `ITokenBudgetManager` in `domain/context/token-budget-manager.ts`; initialize the `cl100k_base` tiktoken encoder once at construction and reuse it
  - `countTokens(text)` — encode text and return length; on tiktoken encode error fall back to `Math.ceil(text.length / 4)` and log a warning
  - `allocate(config)` — scale per-layer defaults to fit within `modelTokenLimit * (1 - safetyBufferFraction)` and return a `LayerBudgetMap` whose budget values sum to ≤ the effective total
  - `checkBudget(content, budget)` — return `{ tokensUsed, overBy }` where `overBy` is 0 when within budget
  - `checkTotal(layerTokenCounts, totalBudget)` — sum layer tokens and return the signed difference (positive = overage)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 5. Implement LayerCompressor
  - Implement `ILayerCompressor` in `domain/context/layer-compressor.ts`; pure domain, no I/O
  - Spec extraction (`activeSpecification`): apply regex `/^#{1,4}\s.+/gm` for headings and collect acceptance-criteria list items within those sections; join retained lines
  - Code skeleton extraction (`codeContext`): apply `/^export\s+(function|class|interface|type|const|abstract)/gm` and retain only the matched declaration lines (signatures only — no bodies, no closing braces); this is intentional — the goal is to surface the public API surface for the LLM, not to produce syntactically valid code; multi-line type definitions not fully captured are a known v1 limitation
  - Memory score filter (`memoryRetrieval`): parse entries as objects with a `relevanceScore` field and drop those below 0.3; join retained entries
  - Truncation fallback: after any extraction, if `tokenCounter(result) > budget`, slice to `budget * 4` characters
  - Guard: return the original content unchanged when `layerId` is `systemInstructions` or `taskDescription`; emit a warning when compression is called on those layers
  - Record `originalTokenCount`, `technique`, and final `tokenCount` in the returned `CompressionResult`
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [ ] 6. Implement ContextAccumulator
  - Implement `IContextAccumulator` in `domain/context/context-accumulator.ts`; pure domain state, no I/O
  - Store accumulated entries in a `Map<string, AccumulatedEntry[]>` keyed by `"phaseId:taskId"`
  - `accumulate(entry)` — add to the correct scope; validate that entry's `phaseId` matches the active phase or throw
  - `getEntries(phaseId, taskId)` — filter entries so only those whose `phaseId` matches are returned; never return entries from a different phase
  - `recordExpansion(event)` — increment the counter and return `{ ok: false, errorReason }` when `expansionCount >= maxExpansionsPerIteration`; otherwise append to the event log
  - `resetPhase(phaseId)` — delete all entries keyed under the given phaseId and reset the expansion counter
  - `resetTask(taskId)` — delete all entries for any key ending in `:taskId` and reset the expansion counter
  - Tag every entry with the `phaseId` under which it was accumulated so the assembly filter can enforce phase isolation
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 7. Implement ContextCache
  - Implement `IContextCache` in `application/context/context-cache.ts`; uses `fs.stat` I/O so belongs in the application layer
  - Back the store with a `Map<string, CachedEntry>` and an ordered access list for LRU eviction; enforce a configurable capacity limit (default 50)
  - `get(filePath, currentMtime)` — return the cached entry only when `entry.mtime === currentMtime`; return null and increment miss counter on staleness or absence
  - `set(entry)` — store the entry; if at capacity, evict the least-recently-used entry before inserting
  - `invalidate(filePath)` — remove the entry if present
  - `stats()` — return cumulative `{ hits, misses, entries }` counts
  - Note: the restriction on which layers may be cached is enforced by the caller (`ContextEngineService`), not by `ContextCache` itself — `CachedEntry` has no `layerId` field
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 8. Implement ContextEngineService — core context assembly
- [ ] 8.1 Scaffold the service class and layer population helpers
  - Create `application/context/context-engine-service.ts` implementing `IContextEngine`
  - Accept `MemoryPort`, `IToolExecutor`, `IContextPlanner`, `ITokenBudgetManager`, `ILayerCompressor`, `IContextAccumulator`, `IContextCache`, and an optional `TokenBudgetConfig` in the constructor
  - Implement `buildContext(request)` entry point: start a timer for `durationMs`, validate required fields, and delegate layer population to individual helpers
  - Implement `populateSystemInstructions()`: call `fs.stat` on the configured steering-doc paths, consult the cache, read from disk on miss, update cache on miss
  - Implement `populateTaskDescription()`: derive content directly from `request.taskDescription`; no compression or caching
  - Implement `populateActiveSpecification()`: read spec artifacts from the orchestrator workflow state path; wrap in try/catch; omit layer and set degraded on failure
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 6.1, 6.2, 6.3, 10.3, 11.3_

- [ ] 8.2 Implement repository state, memory, code context, and tool result layer population
  - `populateRepositoryState()`: call `IToolExecutor.invoke("git_status")`; format output as `Branch: <branch>\nStaged: <files>\nUnstaged: <files>`; omit layer on tool failure, log error
  - `populateMemoryRetrieval()`: call `MemoryPort.query({ text: taskDescription, topN: 5 })`; format ranked entries as memory layer content; omit layer on memory-system failure, log warning
  - `populateCodeContext(plan)`: if `plan.codeContextQuery.pattern` is present, call `IToolExecutor.invoke("search_files", { pattern })` once; otherwise call `IToolExecutor.invoke("read_file", { path })` for each entry in `plan.codeContextQuery.paths`; concatenate all results; omit the layer and log an error on any tool failure
  - `populateToolResults(previousToolResults)`: format the entries array as tool-results layer content; always succeed (input is already in-memory)
  - Apply the planner's `layersToRetrieve` list to skip unrequested layers entirely
  - _Requirements: 1.3, 1.5, 2.1, 2.4, 10.1, 10.2, 10.4, 10.5, 11.1, 11.2_

- [ ] 8.3 Implement token budget enforcement and compression within buildContext
  - After populating all layers, call `TokenBudgetManager.allocate()` to get per-layer budgets
  - For each populated layer check budget; call `LayerCompressor.compress()` on any layer that exceeds its allocation (skip `systemInstructions` and `taskDescription`)
  - After per-layer compression, call `TokenBudgetManager.checkTotal()`; if total exceeds the model limit, truncate the lowest-priority populated layer (reverse canonical order) to the remaining budget and emit an error log entry with the overage amount
  - Assemble the final `content` string with `=== [LAYER: <layerId>] ===\n<content>` separators in canonical order
  - Populate `layers` (the structured per-layer array) alongside `content` so callers can access individual layer content without string parsing
  - Populate `layerUsage` with one `LayerTokenUsage` per assembled layer and set `degraded` + `omittedLayers` from the population helpers' error records
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 11.4, 11.5_

- [ ] 9. Implement ContextEngineService — expansion, reset, and observability
- [ ] 9.1 Implement expandContext
  - Validate that `targetLayer` is one of `codeContext`, `activeSpecification`, or `memoryRetrieval`; return `{ ok: false, errorReason }` immediately for any other layer
  - Fetch the resource identified by `resourceId` through `IToolExecutor` (read_file) or memory port depending on `targetLayer`
  - Call `ContextAccumulator.recordExpansion()` before appending; return `{ ok: false, errorReason }` if the expansion limit is reached
  - Re-run the budget check on the affected layer after appending; compress if over budget
  - Emit an expansion log entry with `resourceId`, `targetLayer`, and new cumulative token count
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 9.2 Implement resetPhase and resetTask
  - `resetPhase(phaseId)`: call `ContextAccumulator.resetPhase(phaseId)`; do not touch `ContextCache` — it is session-scoped and persists naturally across phase transitions; emit a `PhaseResetEvent` structured log entry `{ phaseId, timestamp }`
  - `resetTask(taskId)`: call `ContextAccumulator.resetTask(taskId)`; emit a `TaskResetEvent` log entry `{ taskId, timestamp }`; release accumulated token budget allocations for the task scope
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.4, 8.5_

- [ ] 9.3 Implement structured observability emission
  - After every `buildContext()` call, emit a `ContextAssemblyLog` entry containing: `sessionId`, `phaseId`, `taskId`, `stepType`, `layersAssembled`, `layerTokenCounts`, `cacheHits`, `cacheMisses`, `totalTokens`, `compressed`, `omittedLayers`, `degraded`, `durationMs`
  - Log planner decisions when they are made: `selectedFiles`, `memoryQuery`, `specSections`, `rationale`
  - Log each compression event: layer name, original token count, compressed token count, technique used
  - Confirm that no helper passes raw layer content to the logger — only metadata fields are emitted at every log call site
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 10. Write unit tests for all domain components
- [ ] 10.1 (P) Unit tests for ContextPlanner
  - Verify each `StepType` produces the correct `layersToRetrieve` set including always-present layers
  - Verify `rationale` is populated and contains the step type and a task description excerpt
  - Verify that the planner never adds `systemInstructions` or `taskDescription` to the explicit retrieve list (they are unconditional)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 10.2 (P) Unit tests for TokenBudgetManager
  - Verify token counts for known fixed strings match expected values from cl100k_base encoding
  - Verify `allocate()` returns budgets whose sum is ≤ the effective model limit (after safety buffer)
  - Verify `checkBudget()` returns `overBy > 0` when content exceeds budget
  - Verify the fallback approximation is used when tiktoken throws during `countTokens()`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 10.3 (P) Unit tests for LayerCompressor
  - Verify spec extraction retains headings and acceptance-criteria bullet lines while removing body prose
  - Verify code skeleton extraction retains `export` declaration lines and drops function bodies
  - Verify memory score filter drops entries with `relevanceScore < 0.3` and retains higher-scored entries
  - Verify truncation fallback is applied when extraction leaves the content over budget
  - Verify that calling compress on `systemInstructions` or `taskDescription` returns the original content unchanged
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [ ] 10.4 (P) Unit tests for ContextAccumulator
  - Verify that `getEntries()` never returns entries whose `phaseId` differs from the requested phase
  - Verify `recordExpansion()` returns `{ ok: false }` once `maxExpansionsPerIteration` is reached
  - Verify `resetPhase()` removes only entries tagged with the given phaseId and resets the expansion counter
  - Verify `resetTask()` removes only entries tagged with the given taskId and does not touch entries from other tasks
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 10.5 (P) Unit tests for ContextCache
  - Verify `get()` returns the cached entry when `currentMtime` matches and null when it differs
  - Verify LRU eviction occurs when the store reaches capacity (51st insert evicts the least-recently-used entry)
  - Verify `stats()` increments `hits` and `misses` correctly across successive `get()` calls
  - Verify `invalidate()` removes the specific entry and does not affect other entries
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 11. Write integration tests for ContextEngineService
- [ ] 11.1 Core buildContext integration tests
  - Test a full `Exploration` step with mock `MemoryPort` and `IToolExecutor`: verify all expected layers are assembled in canonical order
  - Test that the assembled `content` string contains `=== [LAYER: <layerId>] ===` separators in the correct order
  - Test that `layerUsage` contains exactly the assembled layers and no others
  - Test that `plannerDecision` is reflected in the result
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.5_

- [ ] 11.2 Graceful degradation integration tests
  - Test that `buildContext()` returns `{ degraded: true, omittedLayers: ["memoryRetrieval"] }` when `MemoryPort.query()` throws
  - Test that `buildContext()` returns `{ degraded: true }` when `IToolExecutor.invoke("git_status")` fails
  - Test that `buildContext()` omits `activeSpecification` (and does not substitute `taskDescription`) when the spec file path is not found
  - Verify that every omitted layer produces a log entry at warning or error level
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 11.3 Compression integration tests
  - Test that compression is applied to the `codeContext` layer when the mock returns oversized content
  - Test that `systemInstructions` and `taskDescription` layers are never compressed regardless of size
  - Test that `layerUsage[i].compressed` is true only for layers that were actually compressed
  - _Requirements: 3.2, 4.1, 4.6_

- [ ] 11.4 expandContext integration tests
  - Test that `expandContext()` appends content to the correct layer and re-runs the budget check
  - Test that `expandContext()` returns `{ ok: false }` when `targetLayer` is `systemInstructions`
  - Test that `expandContext()` returns `{ ok: false }` once the configured expansion limit is reached
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 11.5 Phase and task isolation integration tests
  - Test that `resetPhase()` causes a subsequent `buildContext()` to contain no tool results or memory entries from the previous phase
  - Simulate two sequential phases end-to-end: verify zero cross-phase context leakage
  - Test that `resetTask()` clears accumulated context for the completed task and a new task starts with only system instructions, task description, and planner-selected spec sections
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5_
