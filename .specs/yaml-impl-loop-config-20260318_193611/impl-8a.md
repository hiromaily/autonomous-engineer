# Task 8a Implementation Summary: Domain validation tests (`tests/domain/framework.test.ts`)

## File Created

`orchestrator-ts/tests/domain/framework.test.ts`

## Changes Made

Created a new test file with a single `describe("validateFrameworkDefinition - loopPhases")` block containing 6 tests:

1. **Accepts valid loop-phases** — builds a definition with three valid sub-phases (one each of `llm_slash_command`, `llm_prompt`, `git_command`) and verifies no error is thrown.

2. **Throws on unknown loop-phase type** — uses a cast-to-`never` to inject `"implementation_loop"` as a loop-phase type at runtime and asserts the exact error message including the invalid type and the list of valid types.

3. **Throws on `llm_slash_command` with empty content** — verifies the exact error message `(type: llm_slash_command) must have non-empty content`.

4. **Throws on `llm_prompt` with empty content** — verifies the exact error message `(type: llm_prompt) must have non-empty content`.

5. **Accepts `git_command` with empty content** — verifies that `git_command` with `content: ""` does not throw (empty content is allowed for this type).

6. **Accepts absence of loop-phases (backward compat)** — calls `makeFrameworkDef()` with no arguments and verifies no error is thrown.

## Approach

- Used `makeFrameworkDef()` (from `tests/helpers/workflow.ts`, updated in Task 7) to build `FrameworkDefinition` objects. The helper already injects `loopPhases` into the IMPLEMENTATION phase when the option is provided.
- Error message strings in throw assertions were copied verbatim from `validateFrameworkDefinition` in `framework.ts` to ensure exact match.
- For the unknown-type test, a `as never` cast simulates a bad runtime value that bypasses TypeScript's type system.

## Test Result

```
6 pass
0 fail
Ran 6 tests across 1 file. [10.00ms]
```
