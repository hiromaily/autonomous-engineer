# Implementation Plan

## Task Overview

| # | Task | Parallel | Depends On |
|---|------|----------|-----------|
| 1 | Core types and error model | — | — |
| 2 | Tool Registry | (P) | 1 |
| 3 | Permission System | (P) | 1 |
| 4 | Tool Executor | — | 2, 3 |
| 5 | Filesystem tools | (P) | 1 |
| 6 | Git tools | (P) | 1 |
| 7 | Shell tools | (P) | 1 |
| 8 | Code analysis tools | (P) | 1 |
| 9 | Knowledge tools | (P) | 1 |
| 10 | Integration and wiring | — | 4, 5, 6, 7, 8, 9 |

---

- [ ] 1. Define core tool system types and error model
- [x] 1.1 Define the shared tool interface and execution context types
  - Declare `Tool<Input, Output>` with `name`, `description`, `requiredPermissions`, optional `timeoutMs`, `schema.input`, `schema.output`, and `execute`
  - Declare `ToolContext` with `workspaceRoot`, `workingDirectory`, `permissions`, `memory`, and `logger`
  - Declare `PermissionFlag` union, `PermissionSet` (frozen record), `ExecutionMode` union, and `JSONSchema` type alias
  - All types use strict TypeScript; no `any`; all fields `readonly`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.1, 4.2, 4.4_

- [x] 1.2 Define the error model, result type, and observability types
  - Declare `ToolErrorType` union (`validation | runtime | permission`), `ToolError` with `type`, `message`, and optional `details`
  - Declare `ToolResult<T>` as a discriminated union mirroring the existing `LlmResult` pattern
  - Declare forward-reference ports: minimal `MemoryClient` (search method), `MemoryEntry`, `Logger` (info/error), and `ToolInvocationLog` with all required fields
  - _Requirements: 1.5, 10.1, 10.2, 10.3, 10.4, 10.5, 11.1, 11.4_

---

- [ ] 2. Build the Tool Registry
- [x] 2.1 (P) Implement the ToolRegistry with register, retrieve, and list operations
  - Implement in-memory `Map<string, Tool<unknown, unknown>>` keyed by tool name
  - `register` rejects duplicate names with a typed `RegistryResult { ok: false }` — never silently overwrites
  - `get` returns `RegistryResult { ok: false, error: { type: 'not_found' } }` for unknown names; never throws
  - `list` returns all registered tools with name, description, and schema
  - Define `IToolRegistry` port interface for dependency injection
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2.2 Test the ToolRegistry
  - Verify successful registration and retrieval by name
  - Verify duplicate registration is rejected with a conflict error
  - Verify `get` on an unregistered name returns a typed not-found error
  - Verify `list` includes all registered tools with correct schema shapes
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

---

- [ ] 3. Build the Permission System
- [x] 3.1 (P) Implement the four execution mode profiles and permission checking logic
  - Define the four `ExecutionMode` profiles as frozen compile-time constants:
    - ReadOnly: filesystemRead only
    - Dev: filesystemRead + filesystemWrite
    - CI: filesystemRead + shellExecution
    - Full: all flags true
  - Implement `resolvePermissionSet(mode)` returning the corresponding frozen `PermissionSet`
  - Implement `checkPermissions(requiredFlags, activePermissions)` returning `{ granted, missingFlags }`
  - Define `IPermissionSystem` port interface
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 3.2 Test the Permission System
  - Verify each mode resolves to exactly the correct set of flags
  - Verify `checkPermissions` correctly identifies missing flags for each combination
  - Verify `checkPermissions` grants permission when all required flags are present
  - Verify that `PermissionSet` returned by `resolvePermissionSet` is frozen (immutable)
  - _Requirements: 4.1, 4.2, 4.3, 4.5_

---

- [ ] 4. Build the Tool Executor
- [x] 4.1 Implement the full tool invocation pipeline with schema validation, timeout, and logging
  - Integrate `ajv v8` as the JSON Schema validator; compile schemas on first invocation and cache per tool name
  - Pipeline order: registry lookup → permission check (using `requiredPermissions`) → input schema validation → `execute` with timeout race → output schema validation → log emission
  - Resolve per-invocation timeout as `tool.timeoutMs ?? config.defaultTimeoutMs`; abort via `AbortController` on expiry
  - Catch all unhandled exceptions from `execute`; wrap as `ToolError { type: 'runtime' }`
  - Sanitize `inputSummary` to at most `logMaxInputBytes` characters before writing to `ToolInvocationLog`
  - Emit one `ToolInvocationLog` entry via `context.logger` on every code path before returning
  - Define `IToolExecutor` port with `invoke(name, rawInput, context): Promise<ToolResult<unknown>>`; callers narrow the result type at call site
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 4.2 Test the Tool Executor
  - Unit test each error path: tool not found, permission denied, input validation failure, output validation failure, timeout exceeded, unhandled exception
  - Unit test success path: correct output returned, log entry emitted with duration and output size
  - Verify log sanitization: input larger than threshold is truncated with a size annotation
  - Verify schema compilation is cached: ajv `compile` is called once per unique tool across multiple invocations
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 11.1, 11.2, 11.3, 11.5_

---

- [ ] 5. Implement filesystem tools
- [x] 5.1 (P) Implement `read_file` and `write_file` with workspace path validation
  - Implement shared `resolveWorkspacePath` utility: resolves the requested path, rejects traversal outside `workspaceRoot` with `ToolError { type: 'permission' }`
  - `read_file`: reads UTF-8 content; returns `ToolError { type: 'runtime' }` when the file does not exist
  - `write_file`: writes UTF-8 content, creates parent directories; requires `filesystemWrite` in `requiredPermissions`
  - Both tools declare correct JSON Schema for input and output
  - _Requirements: 5.1, 5.2, 5.5_

- [x] 5.2 Implement `list_directory` and `search_files`
  - `list_directory`: returns structured entries (name, type: file/directory, size); requires `filesystemRead`; applies workspace path validation
  - `search_files`: returns matching file paths for a given glob or regex pattern within the specified directory; requires `filesystemRead`; applies workspace path validation
  - _Requirements: 5.3, 5.4, 5.5_

- [x] 5.3 Integration-test filesystem tools
  - `read_file` returns correct content for a known file; returns runtime error for missing file
  - `write_file` creates the file and can be read back; parent directories are created when absent
  - `list_directory` returns the correct entry list for a known directory
  - `search_files` returns only paths that match the pattern
  - Path traversal is rejected for all tools with a permission error
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

---

- [ ] 6. Implement git tools
- [x] 6.1 (P) Implement `git_status` and `git_diff`
  - `git_status`: returns structured output with staged, unstaged, and untracked file lists; no permission required
  - `git_diff`: accepts optional `staged`, `base`, and `head` options; returns raw diff string; no permission required
  - All git invocations use `execFile('git', args, { cwd: workingDirectory })` for injection safety
  - Git errors are surfaced as `ToolError { type: 'runtime' }` with stderr in `details`
  - _Requirements: 6.1, 6.2, 6.5_

- [x] 6.2 (P) Implement `git_commit`, `git_branch_list`, `git_branch_create`, and `git_branch_switch`
  - `git_commit`: creates a commit from currently staged changes with the provided message; requires `gitWrite`; returns commit hash
  - `git_branch_list`: lists all branches and identifies current branch; no permission required
  - `git_branch_create`: creates a new branch at HEAD; requires `gitWrite`; returns the new branch name
  - `git_branch_switch`: checks out an existing branch; requires `gitWrite`; returns the branch switched to
  - _Requirements: 6.3, 6.4, 6.5_

- [x] 6.3 Integration-test git tools
  - `git_status` returns correct staged/unstaged/untracked lists in a test repository
  - `git_commit` creates a real commit and returns a valid hash
  - `git_branch_list` returns all branches with current branch identified
  - `git_branch_create` and `git_branch_switch` succeed in a test repository; git errors produce typed runtime errors
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

---

- [ ] 7. Implement shell tools
- [x] 7.1 (P) Implement `run_command` with process execution and output capture
  - Accept `command`, `args` array, and optional `cwd`; execute via `execFile` with array arguments to prevent shell interpolation
  - Capture and return `stdout`, `stderr`, and `exitCode`; non-zero exit code is a valid result (not an error)
  - Requires `shellExecution` permission; respect per-tool timeout
  - _Requirements: 7.1, 7.4, 7.5_

- [x] 7.2 (P) Implement `run_test_suite` and `install_dependencies`
  - `run_test_suite`: invokes the specified test framework runner; parses output into a structured result with passed/failed counts and failure messages; requires `shellExecution`
  - `install_dependencies`: runs the appropriate package manager install command; returns stdout, stderr, and exit code; requires `shellExecution`
  - Both tools apply workspace path validation for any `cwd` parameter
  - _Requirements: 7.2, 7.3, 7.5_

- [x] 7.3 Integration-test shell tools
  - `run_command` captures stdout and stderr; exit code is correctly forwarded
  - Timeout causes process termination and returns a runtime error
  - `run_test_suite` produces a structured pass/fail result for a simple test fixture
  - _Requirements: 7.1, 7.2, 7.4, 7.5_

---

- [ ] 8. Implement code analysis tools
- [x] 8.1 (P) Implement `parse_typescript_ast`
  - Use `ts.createProgram` with the file path and the project's `tsconfig.json` to build a typed AST
  - Extract and return top-level declarations (kind, name, line), import module specifiers, and export names
  - Return `ToolError { type: 'runtime' }` with parse error details when the file cannot be parsed
  - Requires `filesystemRead` permission; applies workspace path validation
  - _Requirements: 8.1, 8.5_

- [x] 8.2 Implement `find_symbol_definition` and `find_references`
  - `find_symbol_definition`: search the program for a function, class, or type declaration by name within the configured scope; return file path, line number, and signature; return `null` in output when not found
  - `find_references`: return all usage sites of the symbol across workspace files with file path and line number per reference
  - Both tools reuse the shared program creation approach from 8.1
  - _Requirements: 8.2, 8.3, 8.5_

- [x] 8.3 Implement `dependency_graph` and integration-test all code analysis tools
  - `dependency_graph`: traverse imports from the given entry point; build and return a list of nodes each with its direct dependency module specifiers; include both direct and transitive dependencies
  - Integration tests: `parse_typescript_ast` returns correct declarations for a known file; `find_symbol_definition` locates a known symbol; `find_references` returns expected sites; `dependency_graph` produces correct nodes; parse error produces a typed runtime error
  - _Requirements: 8.4, 8.5_

---

- [ ] 9. Implement knowledge tools
- [x] 9.1 (P) Implement `search_memory`, `retrieve_spec`, and `retrieve_design_doc`
  - `search_memory`: delegate entirely to `context.memory.search(query)`; return the ranked entry list; requires no file permissions; does not instantiate its own memory connection
  - `retrieve_spec`: read requirements, design, and tasks documents from `.kiro/specs/<specName>/`; return `null` for design and tasks when files are absent; requires `filesystemRead`; applies workspace path validation
  - `retrieve_design_doc`: read the specified architecture document from `docs/`; return `ToolError { type: 'runtime' }` when the path does not exist; requires `filesystemRead`; applies workspace path validation
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 9.2 Integration-test knowledge tools
  - `search_memory` calls `MemoryClient.search` with the query and returns its result (test with a stub client)
  - `retrieve_spec` returns correct document contents for a known spec; returns null fields for missing design/tasks
  - `retrieve_design_doc` returns correct content for a known doc path; returns runtime error for a missing path
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

---

- [ ] 10. Wire all tools together and validate the full system
- [ ] 10.1 Create the bootstrap registration and composition root
  - Write a single bootstrap function that instantiates all tools from all five categories and registers them into the `ToolRegistry`
  - Compose `ToolExecutor` with the registry, the `IPermissionSystem`, and the runtime `ToolExecutorConfig` (defaultTimeoutMs, logMaxInputBytes)
  - Accept `ExecutionMode` as a startup parameter; resolve `PermissionSet` once and embed in `ToolContext`
  - Expose a single `createToolSystem(mode, workspaceRoot, workingDirectory, memory, logger)` factory used by the agent loop
  - _Requirements: 1.4, 2.1, 4.4, 4.5_

- [ ] 10.2 End-to-end tests for the full invocation pipeline and mode enforcement
  - Full pipeline: bootstrap tool system → call `executor.invoke` for each tool category → verify correct `ToolResult` and `ToolInvocationLog` emission
  - Mode enforcement: attempt a `filesystemWrite` operation in `ReadOnly` mode → verify permission error; attempt in `Dev` mode → verify success
  - Verify that schema compilation is cached across repeated invocations of the same tool
  - Verify that a path traversal attempt on a filesystem tool is rejected with a permission error at the tool level
  - _Requirements: 3.1, 3.2, 4.3, 4.5, 5.5, 11.1, 11.4_
