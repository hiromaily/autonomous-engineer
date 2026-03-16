# Research Notes: refactor-directory-structure

## Discovery Type: Light (Existing Codebase Extension/Restructuring)

---

## 1. Current Directory Structure

### Source Tree (`orchestrator-ts/src/`)

```
src/
├── adapters/          # Mixed: outbound adapters (should be in infra)
│   ├── git/           → git-controller-adapter.ts, github-pr-adapter.ts
│   ├── llm/           → claude-provider.ts, mock-llm-provider.ts
│   ├── safety/        → approval-gateway.ts, audit-logger.ts, sandbox-executor.ts
│   ├── sdd/           → cc-sdd-adapter.ts, mock-sdd-adapter.ts
│   └── tools/         → code-analysis.ts, filesystem.ts, git.ts, knowledge.ts, shell.ts
├── application/
│   ├── agent/         → agent-loop-service.ts, debug-agent-event-bus.ts
│   ├── context/       → context-cache.ts, context-engine-service.ts
│   ├── git/           → git-integration-service.ts
│   ├── implementation-loop/ → implementation-loop-service.ts, llm-review-engine.ts, quality-gate-runner.ts
│   ├── planning/      → task-planning-service.ts
│   ├── ports/         → agent-loop.ts, config.ts, context.ts, debug.ts, git-controller.ts,
│   │                    git-event-bus.ts, implementation-loop.ts, llm.ts, memory.ts,
│   │                    pr-provider.ts, sdd.ts, self-healing-loop-logger.ts, task-planning.ts, workflow.ts
│   ├── safety/        → emergency-stop-handler.ts, guarded-executor.ts, ports.ts
│   ├── self-healing-loop/ → self-healing-loop-service.ts
│   ├── tools/         → executor.ts
│   ├── usecases/      → run-spec.ts
│   └── workflow/      → debug-approval-gate.ts
├── cli/               # Inbound adapter (should be under adapters/cli)
│   → config-wizard.ts, configure-command.ts, debug-log-writer.ts, index.ts,
│     json-log-writer.ts, renderer.ts
├── domain/
│   ├── agent/         → types.ts
│   ├── context/       → context-accumulator.ts, context-planner.ts, layer-compressor.ts,
│   │                    layer-registry.ts, token-budget-manager.ts
│   ├── debug/         → types.ts
│   ├── engines/       [EMPTY — 0 files]
│   ├── git/           → git-validator.ts, types.ts
│   ├── implementation-loop/ → types.ts
│   ├── planning/      → plan-validator.ts, types.ts
│   ├── safety/        → constants.ts, guards.ts, stateful-guards.ts, stateless-guards.ts, types.ts
│   ├── self-healing/  → types.ts
│   ├── tools/         → permissions.ts, registry.ts, types.ts
│   └── workflow/      → approval-gate.ts, phase-runner.ts, types.ts, workflow-engine.ts
└── infra/
    ├── config/        → config-loader.ts, config-writer.ts, sdd-framework-checker.ts
    ├── events/        → git-event-bus.ts, workflow-event-bus.ts
    ├── git/           → create-git-integration-service.ts
    ├── implementation-loop/ → create-implementation-loop-service.ts, ndjson-logger.ts
    ├── memory/        → file-memory-store.ts, short-term-store.ts
    ├── planning/      → plan-file-store.ts
    ├── safety/        → create-safety-executor.ts
    ├── self-healing/  → ndjson-logger.ts
    └── state/         → workflow-state-store.ts
```

### Test Tree (`orchestrator-ts/tests/`)

```
tests/
├── adapters/          # Will migrate to tests/infra/
│   ├── git/
│   ├── safety/
│   └── tools/
├── application/       # Needs internal reorganization
│   ├── agent/
│   ├── context/
│   ├── git/
│   ├── implementation-loop/
│   ├── planning/
│   ├── ports/
│   ├── safety/
│   ├── self-healing-loop/
│   ├── tools/
│   └── workflow/
├── cli/               # Will migrate to tests/adapters/cli/
├── domain/
├── e2e/
├── infra/
└── integration/
```

---

## 2. Key Findings

### Finding 1: Dependency Violation in Application Layer

`src/application/implementation-loop/quality-gate-runner.ts` imports directly from `@/adapters/tools/shell`:

```typescript
import { runCommandTool } from "@/adapters/tools/shell";
import type { RunCommandOutput } from "@/adapters/tools/shell";
```

This violates the Clean Architecture dependency rule (application must not import adapters). After relocation of `adapters/tools/shell` to `infra/tools/shell`, the import path changes. However, the architectural violation (application importing a concrete tool) also needs to be addressed — by either:
- Moving `runCommandTool` to an `infra/` path and updating the import, or
- Defining a port-level tool descriptor in `application/ports/` that `quality-gate-runner.ts` uses

Since the requirements specify only a structural refactoring without behavioral changes, the simplest fix is to update the import path to reflect the new `infra/tools/shell` location.

### Finding 2: DI Composition Happens in cli/index.ts

`src/cli/index.ts` performs all dependency injection wiring (instantiates providers, adapters, use cases, and assembles them). After the refactoring, this composition logic should move to `src/infra/bootstrap/`, with `src/adapters/cli/index.ts` delegating to it. This is the most structurally significant change.

### Finding 3: package.json and tsconfig.json Require Minor Updates

- `orchestrator-ts/package.json` has `bin.aes` pointing to `./src/cli/index.ts` — this must be updated to `./src/adapters/cli/index.ts` after relocation.
- `orchestrator-ts/tsconfig.json` `include` array lists `src/cli/**/*` — must be updated to `src/adapters/**/*` (or expand existing pattern).
- Path alias `@/*` maps to `src/*`, so all imports using `@/cli/...` must become `@/adapters/cli/...` and `@/adapters/...` tool imports become `@/infra/...`.

### Finding 4: application/safety/ports.ts Conflicts with application/ports/

`src/application/safety/ports.ts` defines `IAuditLogger`, `IApprovalGateway`, and `ISandboxExecutor`. These are port interfaces for safety capabilities and belong in `src/application/ports/` (e.g., as `src/application/ports/safety.ts`). The existing safety handler files (`emergency-stop-handler.ts`, `guarded-executor.ts`) are services and belong in `src/application/services/safety/`.

### Finding 5: Infra Git Merge Conflict Scenario

`src/infra/git/create-git-integration-service.ts` currently imports from `@/adapters/git/`. After moving git adapters to `src/infra/git/`, there will be two files in the same directory: the existing factory and the moved adapter files. No naming conflicts exist — the factory is named `create-git-integration-service.ts` while adapters are `git-controller-adapter.ts` and `github-pr-adapter.ts`.

### Finding 6: domain/engines/ is Empty

The `src/domain/engines/` directory contains 0 files and should be removed as part of this refactoring (Requirement 4.2).

### Finding 7: application/ Service Subdirectories Already Partially Exist

The `application/` layer already has domain-grouped subdirectories (agent, context, git, implementation-loop, planning, self-healing-loop, tools, workflow). These map cleanly to `services/` in the target structure. The only new directory is `services/safety/` for the two safety orchestration files.

---

## 3. Integration Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Import path churn (many files reference @/adapters) | Medium | Systematic grep-and-replace; typecheck validates completeness |
| package.json bin path update breaks CLI entrypoint | High | Update bin path and script paths atomically with file moves |
| tsconfig.json include miss after cli/ removal | Medium | Update include to cover src/adapters/**/* |
| quality-gate-runner.ts application→infra import | Low | Update import path after tools move; no logic change |
| Test mirror drift (orphaned test files) | Medium | Mirror all source moves in tests/ in the same task |
| DI composition logic split between cli/index.ts and new bootstrap | Medium | Move wiring block to infra/bootstrap/; CLI calls bootstrap factory |

---

## 4. Files and Components to Modify

### Files to Move (Source)
| From | To |
|------|----|
| `src/cli/` (all 6 files) | `src/adapters/cli/` |
| `src/adapters/llm/` | `src/infra/llm/` |
| `src/adapters/git/` | `src/infra/git/` (alongside existing factory) |
| `src/adapters/sdd/` | `src/infra/sdd/` |
| `src/adapters/tools/` | `src/infra/tools/` |
| `src/adapters/safety/` | `src/infra/safety/` (alongside existing factory) |
| `src/application/safety/emergency-stop-handler.ts` | `src/application/services/safety/` |
| `src/application/safety/guarded-executor.ts` | `src/application/services/safety/` |
| `src/application/safety/ports.ts` | `src/application/ports/safety.ts` |

### Application Layer Service Subdirectories (Rename/Reorganize)
| From | To |
|------|----|
| `src/application/agent/` | `src/application/services/agent/` |
| `src/application/context/` | `src/application/services/context/` |
| `src/application/git/` | `src/application/services/git/` |
| `src/application/implementation-loop/` | `src/application/services/implementation-loop/` |
| `src/application/planning/` | `src/application/services/planning/` |
| `src/application/self-healing-loop/` | `src/application/services/self-healing-loop/` |
| `src/application/tools/` | `src/application/services/tools/` |
| `src/application/workflow/` | `src/application/services/workflow/` |
| `src/application/usecases/` | `src/application/usecases/` (no change) |
| `src/application/ports/` | `src/application/ports/` (no change, add safety.ts) |

### Config Files to Update
- `orchestrator-ts/package.json`: `bin.aes`, `scripts.aes`, `scripts.aes:dev`, `scripts.build`
- `orchestrator-ts/tsconfig.json`: `include` array

### Files to Delete
- `src/domain/engines/` (empty directory)

---

## 5. New Directory: infra/bootstrap/

`src/infra/bootstrap/` is introduced as the composition root. The DI wiring code currently in `src/cli/index.ts` (instantiating `ClaudeProvider`, `MockLlmProvider`, `CcSddAdapter`, `MockSddAdapter`, `FileMemoryStore`, `WorkflowStateStore`, `WorkflowEventBus`, `createImplementationLoopService`) moves here.

The bootstrap module exports a factory function such as `createRunDependencies(config, options)` returning an assembled `RunSpecUseCase` plus supporting objects. The CLI entry point calls this factory and only handles argument parsing, rendering, and process lifecycle.
