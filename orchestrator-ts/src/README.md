# orchestrator-ts/src

This directory is the production source of the `aes` CLI. It is organized using **Clean Architecture** with four main layers.

> Architecture reference: [GitHub Issue #19](https://github.com/hiromaily/autonomous-engineer/issues/19)

---

## Directory Structure

```text
src/
├── domain/                          # Pure business rules and domain concepts
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
├── application/                     # Use cases, orchestration services, and abstract ports
│   ├── usecases/
│   ├── services/
│   │   ├── agent/
│   │   ├── context/
│   │   ├── git/
│   │   ├── implementation-loop/
│   │   ├── planning/
│   │   ├── safety/
│   │   ├── self-healing-loop/
│   │   ├── tools/
│   │   └── workflow/
│   └── ports/
│
├── adapters/                        # Inbound delivery adapters (CLI only)
│   └── cli/
│
└── infra/                           # Concrete implementations, config, and dependency injection
    ├── bootstrap/
    ├── config/
    ├── events/
    ├── git/
    ├── implementation-loop/
    ├── llm/
    ├── memory/
    ├── planning/
    ├── safety/
    ├── sdd/
    ├── self-healing/
    ├── state/
    └── tools/
```

---

## Dependency Direction

Dependencies must always point **inward**:

```text
adapters ──┐
           ├──► application ──► domain
infra    ──┘
```

| Layer                  | May depend on                                                   |
| ---------------------- | --------------------------------------------------------------- |
| `domain`               | `domain` only                                                   |
| `application/ports`    | `domain`, other `application/ports`                             |
| `application/services` | `application/ports`, `application/services`, `domain`           |
| `application/usecases` | `application/services`, `application/ports`, `domain`           |
| `adapters/cli`         | `application/usecases`, `infra/bootstrap` (startup wiring only) |
| `infra/*`              | `application/ports`, `domain`                                   |
| `infra/bootstrap`      | all layers (composition root)                                   |

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
| `json-log-writer.ts`   | JSON-oriented log output adapter                          |

---

### `infra/`

Concrete technical implementations. All application port implementations live here, alongside configuration loading and dependency injection. This is the only layer that knows about SDKs, file formats, external APIs, and process environment.

| Directory              | Role                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`           | Composition roots — assembles the full object graph for each command (`create-run-dependencies.ts`, `create-configure-dependencies.ts`, `load-config.ts`) |
| `config/`              | Config file loading (`config-loader.ts`), writing (`config-writer.ts`), and SDD framework detection (`sdd-framework-checker.ts`)                          |
| `events/`              | Concrete event bus implementations (`git-event-bus.ts`, `workflow-event-bus.ts`)                                                                          |
| `git/`                 | Git controller adapter, GitHub PR adapter, git integration service factory                                                                                |
| `implementation-loop/` | Implementation loop service factory                                                                                                                       |
| `logger/`              | Consolidated logger classes: `DebugLogWriter`, `NdjsonImplementationLoopLogger`, `NdjsonSelfHealingLoopLogger`, `AuditLogger`                             |
| `llm/`                 | Claude provider, mock LLM provider                                                                                                                        |
| `memory/`              | File-backed memory store, short-term in-memory store                                                                                                      |
| `planning/`            | Plan file store (persistence for task plans)                                                                                                              |
| `safety/`              | Approval gateway, sandbox executor, safety executor factory                                                                                               |
| `sdd/`                 | Claude Code SDD adapter, mock SDD adapter                                                                                                                 |
| `self-healing/`        | Self-healing loop service factory                                                                                                                         |
| `state/`               | Workflow state store                                                                                                                                      |
| `tools/`               | Shell, filesystem, git, code-analysis, knowledge tool implementations                                                                                     |

#### `infra/bootstrap/` — Composition Root

`infra/bootstrap` is the only place where all layers are wired together. It may import from `application`, `infra`, and `domain` simultaneously. This is intentional — it is the composition root.

```text
adapters/cli/index.ts
  └─► infra/bootstrap/create-run-dependencies.ts
        └─► wires: infra/* → application/ports
                  application/services + usecases
```
