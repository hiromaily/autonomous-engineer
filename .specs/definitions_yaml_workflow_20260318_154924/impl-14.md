# Task 14 Implementation Summary — Update `run-container-di-logging.test.ts`

## What was done

Reviewed and updated `orchestrator-ts/tests/main/run-container-di-logging.test.ts` to reflect the DI container change made in Task 9 (replacing `TypeScriptFrameworkDefinitionLoader` with `YamlWorkflowDefinitionLoader`).

### Error message assertion

The test `"build() rejects with unknown-framework error when sddFramework is not registered"` on line 30 uses `.rejects.toThrow("openspec")`. After Task 9, the error is emitted by `YamlWorkflowDefinitionLoader` with the message:

```
Framework definition file not found: ".../.aes/workflow/openspec.yaml". Create ".aes/workflow/openspec.yaml" to register this framework.
```

This message still contains the substring `"openspec"`, so the existing `.toThrow("openspec")` assertion remains valid with no change required.

### Comment update

Updated the section header comment and `describe()` label from:
- `// Task 7 — Framework selection via TypeScriptFrameworkDefinitionLoader`
- `describe("RunContainer — framework definition loading (Task 7)", …)`

to:
- `// Task 9 — Framework selection via YamlWorkflowDefinitionLoader`
- `describe("RunContainer — framework definition loading (Task 9)", …)`

## Test results

All 13 tests in the file pass (0 failures).
