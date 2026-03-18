# Task 13 Implementation Summary

## File Created

`orchestrator-ts/tests/infra/sdd/yaml-workflow-definition-loader.test.ts`

## Test Cases (10 total, all passing)

### Integration tests (real `.aes/workflow/cc-sdd.yaml`)

1. **Happy path** — `load("cc-sdd")` returns `id === "cc-sdd"` with exactly 14 phases.
2. **Type distribution (llm_prompt)** — all `llm_prompt` phases have a non-undefined `outputFile`.
3. **Type distribution (approvalGate)** — all phases with `approvalGate` also have `approvalArtifact`.
4. **Unknown framework** — `load("unknown")` rejects with a message containing `"unknown"` and the `.aes/workflow/unknown.yaml` path.

### Unit tests (isolated tmpdir)

5. **Missing file** — loader with empty tmpdir rejects with the framework name in the error.
6. **Malformed YAML** — invalid YAML content throws with the file path in the error.
7. **Duplicate phase** — two phases with the same name throws referencing the phase name (`PHASE_A`).
8. **Unknown execution type** — `type: not_a_type` throws mentioning `not_a_type`.
9. **Missing id** — YAML without top-level `id` throws with `"id"` in the message.
10. **approvalArtifact override** — `approval_artifact: custom.md` maps to `approvalArtifact === "custom.md"`.

## Notes

- All `tmpdir`-based tests use `fs.mkdtempSync` + `beforeEach`/`afterEach` cleanup; the real `cc-sdd.yaml` is never modified.
- The duplicate-phase detection is handled by `validateFrameworkDefinition` in the domain layer (already implemented as part of Task 3).
- Result: `10 pass, 0 fail` under `bun test`.
