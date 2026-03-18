# Task 4 Implementation Summary: `yaml-workflow-definition-loader.ts`

## What was done

Created `orchestrator-ts/src/infra/sdd/yaml-workflow-definition-loader.ts` implementing the `FrameworkDefinitionPort` interface.

### Key implementation details

- **Constructor** accepts an optional `workflowDir: string` (defaults to `join(process.cwd(), ".aes", "workflow")`) for testability — unit tests can pass a tmpdir.
- **`load(frameworkId)`** resolves `{workflowDir}/{frameworkId}.yaml`, reads the file with `node:fs/promises readFile`, parses with `js-yaml`'s `load()`, maps to `FrameworkDefinition` via two private methods, then calls `validateFrameworkDefinition()`.
- **Error handling:**
  - File not found: throws with the full file path and a hint to create the YAML file.
  - Malformed YAML: throws with the file path and the underlying parse error.
  - Missing `id` or `phases`: throws structural validation errors referencing the file path.
  - Unknown `type` value: throws listing all valid types.
- **Snake_case to camelCase mapping:** `output_file` → `outputFile`, `approval_gate` → `approvalGate`, `approval_artifact` → `approvalArtifact`, `required_artifacts` → `requiredArtifacts`.
- **`exactOptionalPropertyTypes` compatibility:** optional fields (`approvalGate`, `approvalArtifact`, `outputFile`) are set using conditional spread (`...(condition && { field: value })`) rather than assigning `undefined`, to satisfy the project's strict TypeScript config.

## Typecheck result

`bun run typecheck` produces no errors in production source files. The only remaining errors are in `phase-runner.ts` (pre-existing, part of Task 5, not this task).
