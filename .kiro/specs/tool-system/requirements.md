# Requirements Document

## Project Description (Input)
tool-system

See `spec2: tool-system` section at docs/agent/dev-agent-v1-specs.md.

## Introduction

The Tool System is the structured execution interface between the LLM and the development environment within the Autonomous Engineer system. It provides the deterministic, permission-controlled bridge through which the AI agent performs all filesystem, shell, git, code analysis, and knowledge operations. The Tool System is the foundational execution layer that the agent loop (spec4) depends on, and must be fully operational before higher-level specs can function.

This spec covers the complete tool infrastructure: the common tool interface and execution context, a central registry for tool discovery, an executor that enforces schema validation and timeouts, a permission system that controls access by execution mode, implementations of all five tool categories, structured error handling, and observability through execution logs.

## Requirements

### Requirement 1: Tool Interface

**Objective:** As an AI agent, I want a common, well-defined interface for all tools, so that I can discover, reason about, and invoke any tool through a consistent contract regardless of its category.

#### Acceptance Criteria
1. The Tool System shall define a generic `Tool<Input, Output>` interface with the properties: `name` (unique string identifier), `description` (human-readable string), `schema.input` (JSON Schema), `schema.output` (JSON Schema), `requiredPermissions` (array of `PermissionSet` flag names), and an async `execute(input, context)` function.
2. When a tool is implemented, the Tool System shall require all five interface properties to be present and non-empty.
3. The Tool System shall export `ToolContext` as an interface containing: `workspaceRoot` (string), `workingDirectory` (string), `permissions` (PermissionSet), `memory` (MemoryClient), and `logger` (Logger).
4. When a tool's `execute` function is called, the Tool System shall inject the current `ToolContext` as the second argument so the tool can access workspace, memory, and logging facilities.
5. The Tool System shall require all tool names to be unique identifiers; tool names shall be validated as non-empty strings when a tool is defined.

---

### Requirement 2: Tool Registry

**Objective:** As the agent loop, I want a central registry that indexes all available tools, so that I can discover what tools exist and retrieve their schemas without knowing concrete implementations.

#### Acceptance Criteria
1. The Tool System shall provide a `ToolRegistry` that supports registering a tool via a `register(tool)` method.
2. When a caller requests a tool by name, the Tool System shall return the matching tool instance, or a typed `ToolNotFound` error if the name is not registered.
3. The Tool System shall support a `list()` method that returns all registered tools with their names, descriptions, and schemas.
4. The Tool System shall support schema retrieval for a named tool, returning the full `schema.input` and `schema.output` JSON Schema objects.
5. When a tool is registered with a name already present in the registry, the Tool System shall reject the registration and report a conflict error rather than silently overwriting the existing entry.

---

### Requirement 3: Tool Executor

**Objective:** As the agent loop, I want a tool executor that safely invokes tools with validated inputs and outputs, so that schema violations, timeouts, and runtime errors are caught before results reach the LLM.

#### Acceptance Criteria
1. When a tool is invoked, the Tool System shall validate the input against the tool's `schema.input` JSON Schema before calling `execute`; if validation fails, it shall return a `ToolError` with `type: "validation"` and not invoke the tool.
2. When a tool completes execution, the Tool System shall validate the output against the tool's `schema.output` JSON Schema; if validation fails, it shall return a `ToolError` with `type: "validation"`.
3. When a tool execution exceeds its timeout, the Tool System shall abort execution and return a `ToolError` with `type: "runtime"` and a timeout message; each tool shall declare its own timeout value, with a global default applied when no per-tool value is set.
4. If a tool throws an unhandled exception during execution, the Tool System shall catch the exception, wrap it in a `ToolError` with `type: "runtime"`, and return it rather than propagating the raw exception.
5. The Tool System shall log each tool invocation — including tool name, input parameters, execution duration, output size, and any errors — to the structured execution log before returning the result.

---

### Requirement 4: Permission System

**Objective:** As a system operator, I want a permission system that controls which tools can execute based on the current agent mode, so that destructive or privileged operations cannot occur in restricted environments.

#### Acceptance Criteria
1. The Tool System shall define a `PermissionSet` type with boolean flags: `filesystemRead`, `filesystemWrite`, `shellExecution`, `gitWrite`, and `networkAccess`.
2. The Tool System shall define four named execution modes with fixed permission profiles:
   - `ReadOnly`: `filesystemRead: true`, all others `false`
   - `Dev`: `filesystemRead: true`, `filesystemWrite: true`, all others `false`
   - `CI`: `filesystemRead: true`, `shellExecution: true`, all others `false`
   - `Full`: all flags `true`
3. When a tool is invoked, the Tool System shall check each flag in the tool's `requiredPermissions` against the current `PermissionSet`; if any required flag is not enabled, it shall return a `ToolError` with `type: "permission"` and not execute the tool.
4. The Tool System shall attach the active `PermissionSet` to the `ToolContext` so that tools can also perform their own permission checks for fine-grained operations.
5. When the execution mode is configured at startup, the Tool System shall apply the corresponding `PermissionSet` for the entire session and shall not allow mode escalation at runtime.

---

### Requirement 5: Filesystem Tools

**Objective:** As an AI agent, I want filesystem tools for reading, writing, listing, and searching project files, so that I can inspect and modify the codebase during development tasks.

#### Acceptance Criteria
1. The Tool System shall implement `read_file(path)` that returns the UTF-8 text content of the specified file; if the file does not exist, it shall return a `ToolError` with `type: "runtime"`.
2. The Tool System shall implement `write_file(path, content)` that writes UTF-8 text to the specified path, creating parent directories if needed; this tool shall require `filesystemWrite` permission.
3. The Tool System shall implement `list_directory(path)` that returns a structured list of entries (name, type: file/directory, size) for the specified directory; this tool shall require `filesystemRead` permission.
4. The Tool System shall implement `search_files(pattern, directory)` that returns all file paths matching the given glob or regex pattern within the specified directory.
5. While executing any filesystem tool, the Tool System shall reject paths that traverse outside the `workspaceRoot` (e.g., `../` path components) and return a `ToolError` with `type: "permission"`.

---

### Requirement 6: Git Tools

**Objective:** As an AI agent, I want git tools for querying and managing repository state, so that I can read diffs, track changes, create commits, and manage branches as part of automated development tasks.

#### Acceptance Criteria
1. The Tool System shall implement `git_status()` that returns the current working tree status including staged, unstaged, and untracked files.
2. The Tool System shall implement `git_diff(options)` that returns the diff output for staged, unstaged, or between-branch changes as specified by the caller.
3. The Tool System shall implement `git_commit(message)` that creates a git commit with the provided message from the current staged changes; this tool shall require `gitWrite` permission.
4. The Tool System shall implement `git_branch(options)` that supports listing, creating, and switching branches; branch creation and switching shall require `gitWrite` permission.
5. If a git operation fails due to a git error (e.g., merge conflict, detached HEAD), the Tool System shall return a `ToolError` with `type: "runtime"` and include the raw git error message.

---

### Requirement 7: Shell Tools

**Objective:** As an AI agent, I want shell tools for executing system commands, running tests, and installing dependencies, so that I can perform build, test, and setup operations during the development workflow.

#### Acceptance Criteria
1. The Tool System shall implement `run_command(command, args, cwd)` that executes the specified shell command and returns stdout, stderr, and exit code; this tool shall require `shellExecution` permission.
2. The Tool System shall implement `run_test_suite(framework, options)` that invokes the project's configured test runner and returns a structured result with pass/fail counts and failure details; this tool shall require `shellExecution` permission.
3. The Tool System shall implement `install_dependencies(packageManager, options)` that runs the appropriate package manager install command and returns the installation result.
4. When a shell command execution exceeds the configured timeout, the Tool System shall terminate the process and return a `ToolError` with `type: "runtime"`.
5. The Tool System shall capture both stdout and stderr from shell tool executions and include them in the structured output returned to the caller.

---

### Requirement 8: Code Analysis Tools

**Objective:** As an AI agent, I want code analysis tools for inspecting TypeScript ASTs, finding symbol definitions, tracing references, and querying dependency graphs, so that I can reason about large codebases without loading entire files.

#### Acceptance Criteria
1. The Tool System shall implement `parse_typescript_ast(filePath)` that parses the specified TypeScript file and returns a structured AST summary including top-level declarations, imports, and exports.
2. The Tool System shall implement `find_symbol_definition(symbolName, scope)` that locates the definition of a function, class, or type by name and returns its file path, line number, and signature.
3. The Tool System shall implement `find_references(symbolName, scope)` that returns all usage sites of the specified symbol across the workspace, including file path and line number for each reference.
4. The Tool System shall implement `dependency_graph(entryPoint)` that returns the module dependency graph starting from the specified entry point, including direct and transitive dependencies.
5. If a code analysis tool encounters a file that cannot be parsed (e.g., syntax errors), the Tool System shall return a `ToolError` with `type: "runtime"` and include the parse error details.

---

### Requirement 9: Knowledge Tools

**Objective:** As an AI agent, I want knowledge tools for searching memory and retrieving specification documents, so that I can incorporate relevant past decisions and spec artifacts into my reasoning without managing raw file paths.

#### Acceptance Criteria
1. The Tool System shall implement `search_memory(query)` that queries the memory system (via `MemoryClient`) and returns ranked, relevant memory entries matching the query.
2. The Tool System shall implement `retrieve_spec(specName)` that returns the contents of the specified spec's requirements, design, and task documents from the `.kiro/specs/` directory.
3. The Tool System shall implement `retrieve_design_doc(docPath)` that returns the contents of the specified architecture or design document from the `docs/` directory.
4. When a knowledge tool is called with a spec name or document path that does not exist, the Tool System shall return a `ToolError` with `type: "runtime"` and a descriptive not-found message.
5. The Tool System shall accept the `MemoryClient` from `ToolContext` for all memory operations; knowledge tools shall not instantiate their own memory connections.

---

### Requirement 10: Error Handling

**Objective:** As an AI agent, I want structured tool errors with typed categories, so that I can select appropriate recovery strategies (retry, alternative tool, escalation) based on the error type.

#### Acceptance Criteria
1. The Tool System shall define a `ToolError` type with the fields: `type` (one of `"validation" | "runtime" | "permission"`), `message` (string), and optional `details` (structured metadata).
2. When a tool returns a `ToolError`, the Tool System shall include the `type` field so that the caller can branch recovery logic by error category.
3. The Tool System shall never throw untyped exceptions to the caller; all error paths shall produce a `ToolError` with an appropriate `type`.
4. If a `"validation"` error occurs, the Tool System shall include the specific field(s) that failed validation in the `details` field.
5. If a `"permission"` error occurs, the Tool System shall include the required permission flag name and the current mode in the `details` field.

---

### Requirement 11: Observability

**Objective:** As a developer and system operator, I want all tool executions to be logged with structured metadata, so that I can audit agent behavior, debug failures, and optimize performance.

#### Acceptance Criteria
1. The Tool System shall emit a structured log entry for every tool invocation containing: tool name, input parameters (sanitized), execution start time, execution duration in milliseconds, and result status (success or error type).
2. When a tool execution results in an error, the Tool System shall include the `ToolError` type and message in the log entry.
3. The Tool System shall record the output size (byte count or entry count) in the log entry for successful executions.
4. While the agent is running, the Tool System shall write execution logs to the `logger` provided in `ToolContext`, enabling integration with the orchestrator's event bus.
5. The Tool System shall not log sensitive content (e.g., file contents, secret values) in plaintext; input parameters that exceed a configurable size threshold shall be truncated with a size annotation.
