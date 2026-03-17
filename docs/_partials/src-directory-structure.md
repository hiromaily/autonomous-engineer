<!-- SSOT: orchestrator-ts/src/ directory structure.
     Included by:
       docs/architecture/architecture.md,
       docs/ja/architecture/architecture.md
     Edit only this file when the src/ directory structure changes.
     Note: orchestrator-ts/src/README.md also shows this structure inline
           (GitHub README cannot use @include directives). -->

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
    ├── config/                        # Config loading and SDD framework detection
    ├── events/                        # Concrete event bus implementations
    ├── git/                           # Git controller adapter and GitHub PR adapter
    ├── llm/                           # Claude provider, mock LLM provider
    ├── logger/                        # Logger classes (ConsoleLogger, NdjsonFileLogger, AuditLogger…)
    ├── memory/                        # File-backed and in-memory stores
    ├── planning/                      # Plan file store
    ├── safety/                        # Approval gateway, sandbox executor
    ├── sdd/                           # Claude Code SDD adapter, mock SDD adapter
    ├── state/                         # Workflow state store
    ├── tools/                         # Shell, filesystem, git, code-analysis tool implementations
    └── utils/                         # Shared low-level utilities used within infra only (errors, fs, ndjson)
```
