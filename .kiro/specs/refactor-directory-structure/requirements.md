# Requirements Document

## Project Description (Input)

refactor-directory-structure

The current directory structure follows a Clean Architecture, but it's structurally difficult to understand.

Some of the code was created a while ago and isn't included in the current structure, but I'd like to refactor it to a structure like the one below.

Reference: [Issue #19 – Recommended Directory Structure](https://github.com/hiromaily/autonomous-engineer/issues/19#issue-4075862782)

## Introduction

This specification defines requirements for refactoring the `orchestrator-ts/src/` directory structure to better reflect Clean Architecture / Hexagonal Architecture principles. The goal is to improve understandability and structural correctness without changing any runtime behavior. The refactoring affects source layout, import paths, and the mirrored test directories in `orchestrator-ts/tests/`.

**Target Structure Summary** (from Issue #19):

```
src/
├── domain/        # Pure business rules, types, validators — no external dependencies
├── application/   # Use cases, services, port interfaces
│   ├── usecases/  # Top-level application actions
│   ├── services/  # Reusable orchestration logic
│   └── ports/     # Abstract capability contracts
├── adapters/      # Inbound delivery mechanisms only (CLI)
│   └── cli/       # CLI entry point and terminal rendering
└── infra/         # Concrete port implementations + composition root
                   # (LLM providers, git adapters, tools, safety, storage, events, DI)
```

---

## Requirements

### Requirement 1: Inbound Adapters Directory

**Objective:** As a developer, I want the `adapters/` layer to contain only inbound adapters (CLI), so that the architectural boundary between delivery mechanism and infrastructure is clear.

#### Acceptance Criteria

1. The Refactoring shall move all files under `src/cli/` into `src/adapters/cli/`.
2. When a developer looks at `src/adapters/`, the Refactoring shall ensure that only inbound delivery mechanisms (i.e., CLI) exist there — no LLM, git, SDD, tools, or safety adapter modules.
3. The Refactoring shall preserve all public API and behavior of CLI modules after relocation.
4. If any file in `src/cli/` has import references to other modules, the Refactoring shall update those import paths to resolve correctly from `src/adapters/cli/`.

---

### Requirement 2: Outbound Adapters Relocated to Infrastructure

**Objective:** As a developer, I want all outbound adapter implementations (LLM providers, Git, SDD, tools, safety) to live in `src/infra/`, so that `infra/` is the single home for all concrete external integrations.

#### Acceptance Criteria

1. The Refactoring shall move `src/adapters/llm/` → `src/infra/llm/`.
2. The Refactoring shall move `src/adapters/git/` → `src/infra/git/` (merged with existing `src/infra/git/`).
3. The Refactoring shall move `src/adapters/sdd/` → `src/infra/sdd/`.
4. The Refactoring shall move `src/adapters/tools/` → `src/infra/tools/`.
5. The Refactoring shall move `src/adapters/safety/` → `src/infra/safety/` (merged with existing `src/infra/safety/`).
6. When files are moved, the Refactoring shall update all import statements across the codebase to use the new paths.
7. If a naming conflict exists between a moved file and an existing file in the target `infra/` subdirectory, the Refactoring shall resolve the conflict (e.g., by placing git adapter files in `infra/git/adapters/` and existing factory files in `infra/git/`) without deleting or losing any logic.
8. The Refactoring shall move mock adapter files (`mock-sdd-adapter.ts`, `mock-llm-provider.ts`) from `src/adapters/` to `src/infra/` under their respective subdirectories, since they are test-time concrete implementations of ports, not inbound adapters.

---

### Requirement 3: Application Layer Reorganization

**Objective:** As a developer, I want the `application/` layer to be organized into `usecases/`, `services/`, and `ports/` sub-directories, so that the roles of each module are immediately clear from directory placement.

#### Acceptance Criteria

1. The Refactoring shall ensure all top-level application action files reside under `src/application/usecases/`.
2. The Refactoring shall ensure all reusable orchestration logic (agent, context, git, implementation-loop, planning, self-healing-loop, tools, workflow services) resides under `src/application/services/`.
3. The Refactoring shall keep all port interface files under `src/application/ports/` (no change in principle, but file locations aligned with the new grouping).
4. The Refactoring shall move safety orchestration files (`emergency-stop-handler.ts`, `guarded-executor.ts`) from `src/application/safety/` into `src/application/services/safety/`, and move safety port interfaces (`ports.ts`) into `src/application/ports/`.
5. When reorganizing application modules, the Refactoring shall update all import statements to reflect the new sub-directory paths.

---

### Requirement 4: Domain Layer Preservation

**Objective:** As a developer, I want the `domain/` layer to remain structurally unchanged except for removal of any empty or unused directories, so that domain logic is unaffected by structural refactoring.

#### Acceptance Criteria

1. The Refactoring shall not move or rename any domain source files unless required to remove an empty directory.
2. The Refactoring shall remove the empty `src/domain/engines/` directory if no files exist within it.
3. While the refactoring is in progress, the Domain layer shall remain free from imports of `application/`, `adapters/`, or `infra/` modules.

---

### Requirement 5: Infrastructure Layer Consolidation

**Objective:** As a developer, I want `src/infra/` to serve as the single composition root and concrete implementation layer, consolidating all external service implementations, so that the dependency inversion principle is fully respected.

#### Acceptance Criteria

1. The Refactoring shall ensure `src/infra/` contains all concrete implementations of application ports (LLM, git, SDD, tools, safety, storage, events, config, DI composition).
2. The Refactoring shall preserve existing `src/infra/` sub-modules (`config/`, `events/`, `memory/`, `planning/`, `safety/`, `self-healing/`, `state/`) without behavioral change.
3. The Refactoring shall consolidate all dependency injection and factory composition logic into `src/infra/bootstrap/`, so that the composition root is a single, findable location.
4. The Refactoring shall not introduce any circular dependencies between `infra/` and `application/` or `domain/`.

---

### Requirement 6: Test Directory Mirroring

**Objective:** As a developer, I want the `tests/` directory structure to mirror the refactored `src/` structure exactly, so that test files are easy to locate and maintain.

#### Acceptance Criteria

1. When source files move from `src/cli/` to `src/adapters/cli/`, the Refactoring shall move corresponding test files from `tests/cli/` to `tests/adapters/cli/`.
2. When source files move from `src/adapters/` to `src/infra/`, the Refactoring shall move corresponding test files to the appropriate `tests/infra/` sub-directory.
3. When application modules are reorganized into `usecases/` or `services/`, the Refactoring shall update the corresponding test directory paths accordingly.
4. The Refactoring shall ensure no test files are deleted or left orphaned in the old directory paths.
5. If `tests/adapters/` currently holds tests for outbound adapters (LLM, git, SDD, tools, safety), the Refactoring shall move them to `tests/infra/` to mirror the source relocation.

---

### Requirement 7: Behavioral Preservation and Continuous Integration

**Objective:** As a developer, I want the refactoring to introduce zero functional changes to the system, so that existing tests continue to pass and the `aes` CLI behaves identically before and after the refactoring.

#### Acceptance Criteria

1. The Refactoring shall not alter the logic, behavior, or public interface of any moved or renamed file.
2. When the refactoring is complete, the Orchestrator shall pass all existing tests (`bun test`) without modification to test logic.
3. When the refactoring is complete, the Orchestrator shall pass TypeScript type checking (`bun run typecheck`) with zero errors.
4. If any import path is broken during refactoring, the Refactoring shall detect and fix it before considering a task complete.
5. The Refactoring shall not change any `package.json`, `bunfig.toml`, or build configuration files unless strictly necessary for path resolution.

---

### Requirement 8: Dependency Direction Enforcement

**Objective:** As a developer, I want the refactored structure to enforce the inward dependency rule, so that architectural violations are structurally impossible or immediately visible.

#### Acceptance Criteria

1. The Refactoring shall ensure `domain/` modules have no imports from `application/`, `adapters/`, or `infra/`.
2. The Refactoring shall ensure `application/` modules import only from `domain/` or within `application/` — never from `adapters/` or `infra/`.
3. The Refactoring shall ensure `adapters/cli/` modules handling rendering and command parsing import only from `application/` or `domain/`. If the CLI entry point (`index.ts`) currently performs dependency injection wiring, the Refactoring shall move that composition logic into `src/infra/bootstrap/` and have the CLI entry point delegate to it.
4. The Refactoring shall ensure `infra/` modules implement interfaces defined in `application/ports/` and may import from `domain/` and `application/`.
5. If any file violates the dependency direction after the refactoring, the Refactoring shall be considered incomplete.
