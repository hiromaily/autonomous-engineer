# Task 9 Implementation Summary — Replace `TypeScriptFrameworkDefinitionLoader` with `YamlWorkflowDefinitionLoader` in DI

## Changes Made

**File:** `orchestrator-ts/src/main/di/run-container.ts`

1. Added `import { join } from "node:path"` at the top (required by the new loader constructor call).
2. Replaced `import { TypeScriptFrameworkDefinitionLoader } from "@/infra/sdd/typescript-framework-definition-loader"` with `import { YamlWorkflowDefinitionLoader } from "@/infra/sdd/yaml-workflow-definition-loader"`.
3. In the `frameworkDefinitionLoader` lazy getter, replaced `new TypeScriptFrameworkDefinitionLoader()` with `new YamlWorkflowDefinitionLoader(join(process.cwd(), ".aes", "workflow"))`.

## Verification

- `bun run typecheck` (production files only) passes with zero errors.
- No reference to `TypeScriptFrameworkDefinitionLoader` or `CC_SDD_FRAMEWORK_DEFINITION` remains in the modified file or any other production source file.

## Acceptance Criteria Status

- `RunContainer.build()` with `sddFramework: "cc-sdd"` will resolve correctly (`.aes/workflow/cc-sdd.yaml` exists, created in Task 8).
- `RunContainer.build()` with `sddFramework: "openspec"` will reject with a file-not-found message containing `"openspec"` (emitted by `YamlWorkflowDefinitionLoader`).
- No reference to `TypeScriptFrameworkDefinitionLoader` or `CC_SDD_FRAMEWORK_DEFINITION` in production code.
