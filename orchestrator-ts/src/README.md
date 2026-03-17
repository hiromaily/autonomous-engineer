# orchestrator-ts/src

<!-- SSOT note: The canonical versions of the directory structure and dependency rules below
     are maintained in docs/_partials/src-directory-structure.md and
     docs/_partials/src-dependency-direction.md.
     When updating either section, edit the partials first, then mirror the change here. -->

This directory is the production source of the `aes` CLI. It is organized using **Clean Architecture** with four main layers.

> Architecture reference: [GitHub Issue #19](https://github.com/hiromaily/autonomous-engineer/issues/19)

---

## Directory Structure

```text
src/
├── main/                              # Entry point + top-level DI container (outside Clean Architecture layers)
│   ├── index.ts                       # Process entry point — delegates to CLI adapter
│   └── di/                            # Sub-system DI factories (only callable from main/)
│       ├── run-container.ts           # DI container for the run command (lazy-initialized)
│       ├── configure-container.ts     # DI container for the configure command (lazy-initialized)
│       ├── factories.ts               # Consolidated subsystem factory functions
│       ├── create-git-integration-service.ts
│       └── create-safety-executor.ts
│
├── adapters/                          # Inbound delivery adapters (CLI only)
│   └── cli/                           # Thin layer: parse args, call use case, render output
│
├── application/                       # Use cases, orchestration services, and abstract ports
│   ├── usecases/                      # Top-level entrypoints for application actions (e.g. run-spec.ts)
│   ├── services/                      # Reusable coordination logic (agent, context, git, safety, tools…)
│   │   ├── agent/
│   │   ├── context/
│   │   ├── git/
│   │   ├── implementation-loop/
│   │   ├── planning/
│   │   ├── safety/
│   │   ├── self-healing-loop/
│   │   ├── tools/
│   │   └── workflow/
│   └── ports/                         # Abstract interface definitions (llm, memory, sdd, workflow…)
│
├── domain/                            # Pure business rules and domain concepts (no external dependencies)
│   ├── agent/
│   ├── context/
│   ├── debug/
│   ├── git/
│   ├── implementation-loop/
│   ├── planning/
│   ├── safety/
│   ├── self-healing/
│   ├── tools/
│   └── workflow/
│
└── infra/                             # Concrete port implementations and technical infrastructure
    ├── config/
    ├── events/
    ├── git/
    ├── llm/
    ├── logger/
    ├── memory/
    ├── planning/
    ├── safety/
    ├── sdd/
    ├── state/
    ├── tools/
    └── utils/
```

---

## Dependency Direction

Dependencies must always point **inward**:

```text
adapters ──┐
           ├──► application ──► domain
infra    ──┘
```

| Layer                  | May depend on                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `domain`               | `domain` only                                                                       |
| `application/ports`    | `domain`, other `application/ports`                                                 |
| `application/services` | `application/ports`, `application/services`, `domain`                               |
| `application/usecases` | `application/services`, `application/ports`, `domain`                               |
| `adapters/cli`         | `application/usecases`, `application/ports`                                         |
| `infra/*`              | `application/ports`, `domain`                                                       |
| `main/di/`             | `application/usecases`, `application/services`, `adapters/cli`, `infra/*`, `domain` |
| `main/`                | `main/di/`, `adapters/cli`, `application/ports`, `infra/*`.                         |

---

## Layer Descriptions

### `domain/`

The innermost layer. Contains pure business rules, policies, validations, and domain type definitions. Has **no dependencies** on any other layer, framework, SDK, or I/O.

| Directory              | Contents                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `agent/`               | Agent domain types                                                   |
| `context/`             | Context accumulation, planning, compression, token budget management |
| `debug/`               | Debug-related domain types                                           |
| `git/`                 | Git validation and Git domain types                                  |
| `implementation-loop/` | Implementation loop domain types                                     |
| `planning/`            | Task plan validator and planning types                               |
| `safety/`              | Safety guards (stateful/stateless), constants, and safety types      |
| `self-healing/`        | Self-healing loop domain types                                       |
| `tools/`               | Tool permissions, registry, and tool types                           |
| `workflow/`            | Approval gate, phase runner, workflow engine, and workflow types     |

---

### `application/`

The use case layer. Coordinates domain logic and external capabilities through abstract ports. Must not depend on `adapters` or `infra`.

#### `application/usecases/`

Top-level entrypoints for application actions. Each file represents one use case (e.g., `run-spec.ts`). Receives input, coordinates services and ports, returns output.

#### `application/services/`

Reusable orchestration logic within the use case layer. These services coordinate multiple domain objects and ports but must not know concrete SDKs, file formats, or providers.

| Directory              | Contents                                                            |
| ---------------------- | ------------------------------------------------------------------- |
| `agent/`               | Agent loop service, debug event bus                                 |
| `context/`             | Context cache, context engine service                               |
| `git/`                 | Git integration service                                             |
| `implementation-loop/` | Implementation loop service, LLM review engine, quality gate runner |
| `planning/`            | Task planning service                                               |
| `safety/`              | Emergency stop handler, guarded executor                            |
| `self-healing-loop/`   | Self-healing loop service                                           |
| `tools/`               | Tool executor                                                       |
| `workflow/`            | Debug approval gate                                                 |

#### `application/ports/`

Abstract interface definitions that the application layer depends on for external capabilities. Interfaces are named by business capability, not by technology (e.g., `Llm`, `MemoryStore`, `PrProvider`).

Key port files: `agent-loop.ts`, `config.ts`, `context.ts`, `git-controller.ts`, `git-event-bus.ts`, `implementation-loop.ts`, `llm.ts`, `logging.ts`, `memory.ts`, `pr-provider.ts`, `safety.ts`, `sdd.ts`, `task-planning.ts`, `workflow.ts`

---

### `adapters/`

Inbound delivery adapters only. Reserved for user-facing or protocol-facing entrypoints that call application use cases. Currently contains only the CLI adapter.

#### `adapters/cli/`

Handles command-line input/output, argument parsing, command definitions, and output rendering. Files should stay thin — parse args, call a use case, render output.

| File                   | Role                                                      |
| ---------------------- | --------------------------------------------------------- |
| `index.ts`             | CLI entrypoint, command registration (`run`, `configure`) |
| `configure-command.ts` | `configure` command handler                               |
| `config-wizard.ts`     | Interactive configuration wizard                          |
| `renderer.ts`          | Terminal output rendering                                 |

---

### `main/`

Process entry point and top-level DI container. Sits outside the Clean Architecture layers. The only module that calls `main/di/` factories to assemble the full dependency graph.

| File       | Role                                           |
| ---------- | ---------------------------------------------- |
| `index.ts` | Process entry point — delegates to CLI adapter |

### `main/di/`

Sub-system DI factories. Each file wires a specific subsystem by instantiating concrete service and infra classes and returning a port interface. May import from `application/services`, `application/ports`, `infra/*`, and `domain`. **Only called from `main/`** — nothing else imports from `main/di/`.

| File                                | Role                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `run-container.ts`                  | DI container for the `run` command (lazy-initialized getters)       |
| `configure-container.ts`            | DI container for the `configure` command (lazy-initialized getters) |
| `factories.ts`                      | Consolidated subsystem factory functions                            |
| `create-git-integration-service.ts` | Wires `GitIntegrationService` with its infra dependencies           |
| `create-safety-executor.ts`         | Wires `SafetyGuardedToolExecutor` around a bare `ToolExecutor`      |

---

### `infra/`

Concrete port implementations and technical infrastructure. Each sub-directory implements one or more `application/ports` interfaces using external SDKs, file I/O, or process environment. Must not depend on `application/services`, `adapters`, or `di/`.

| Directory   | Role                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `config/`   | Config file loading (`config-loader.ts`), writing (`config-writer.ts`), and SDD framework detection (`sdd-framework-checker.ts`) |
| `events/`   | Concrete event bus implementations (`git-event-bus.ts`, `workflow-event-bus.ts`)                                                 |
| `git/`      | Git controller adapter, GitHub PR adapter                                                                                        |
| `logger/`   | Logger classes: `ConsoleLogger`, `NdjsonFileLogger`, `JsonLogWriter`, `NdjsonImplementationLoopLogger`, `AuditLogger`            |
| `llm/`      | Claude provider, mock LLM provider                                                                                               |
| `memory/`   | File-backed memory store, short-term in-memory store                                                                             |
| `planning/` | Plan file store (persistence for task plans)                                                                                     |
| `safety/`   | Approval gateway, sandbox executor                                                                                               |
| `sdd/`      | Claude Code SDD adapter, mock SDD adapter                                                                                        |
| `state/`    | Workflow state store                                                                                                             |
| `tools/`    | Shell, filesystem, git, code-analysis, knowledge tool implementations                                                            |
| `utils/`    | Shared low-level utilities used within infra only (`errors.ts`, `fs.ts`, `ndjson.ts`)                                            |
