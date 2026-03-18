# Task 8d Implementation Summary

## What was done

Added a `describe("ImplementationLoopService — configured loop-phases path")` block with **16 new tests** to the existing test file at:
`orchestrator-ts/tests/application/services/implementation-loop/implementation-loop-service.test.ts`

### Import additions

Added three new imports to the test file:
- `LlmProviderPort`, `LlmResult` from `@/application/ports/llm`
- `SddFrameworkPort`, `SddOperationResult`, `SpecContext` from `@/application/ports/sdd`
- `LoopPhaseDefinition` from `@/domain/workflow/framework`

### New test helpers

- `makeSpySdd(result?)` — spy `SddFrameworkPort` that records `executeCommand` calls
- `makeSpyLlm(result?)` — spy `LlmProviderPort` that records `complete` calls
- `makeCommitGitController(sha?)` — stub `IGitController` returning a deterministic commit SHA
- `makeAllThreeLoopPhases()` — convenience function returning one of each sub-phase type

### Tests added (16 total)

| # | Test description | Scenario |
|---|---|---|
| 1 | Returns `outcome: completed` when all sub-phases succeed | Happy path |
| 2 | Dispatches `llm_slash_command` with `content + " " + task.id` | Slash command dispatch |
| 3 | Passes correct `SpecContext` fields (specName, specDir, language) | Context construction |
| 4 | Dispatches `llm_prompt` with interpolated content including `{taskId}` | LLM prompt dispatch |
| 5 | Interpolates `{specName}`, `{specDir}`, `{language}` in `llm_prompt` content | Other interpolations |
| 6 | Dispatches `git_command` by calling `stageAndCommit` with `feat: <title>` | Git dispatch |
| 7 | Returns section status `"completed"` when all sub-phases succeed | Happy path (section level) |
| 8 | Increments `retryCount` when `llm_slash_command` fails | Failure path — SDD |
| 9 | Increments `retryCount` when `llm_prompt` fails | Failure path — LLM |
| 10 | Halts section when `git_command` fails | Failure path — git |
| 11 | Falls back to `agentLoop.run` when `loopPhases` is absent | Fallback |
| 12 | Falls back to `agentLoop.run` when `loopPhases` is empty array | Empty array fallback |
| 13 | Respects `maxRetriesPerSection` in the configured-phases path | Retry logic |
| 14 | Returns descriptive error (in iteration feedback) when `sdd` absent with `llm_slash_command` | Missing dependency |
| 15 | Returns descriptive error (in iteration feedback) when `llm` absent with `llm_prompt` | Missing dependency |
| 16 | Propagates commit SHA from `git_command` sub-phase into `SectionExecutionRecord.commitSha` | Commit SHA propagation |

### Key implementation notes

- Tests 14 and 15 check `section.iterations[0].reviewResult.feedback[0].description` for the descriptive error message, not `section.escalationSummary`. This is because `#escalateSection` always sets `escalationSummary` to the generic `"Section escalated after N failed attempts"` string; the specific sub-phase error is stored in the iteration's feedback.
- All 16 new tests pass, and all 102 pre-existing tests continue to pass (total: 118 tests, 0 failures).
