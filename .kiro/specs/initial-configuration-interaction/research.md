# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `initial-configuration-interaction`
- **Discovery Scope**: Extension (adding `configure` subcommand + modifying `run` error handling)
- **Key Findings**:
  - No interactive prompt library exists in the current dependency set; `@clack/prompts` is the recommended addition
  - `CcSddAdapter` uses a spawned `cc-sdd` CLI binary; the "installed" check for cc-sdd is whether `.kiro/` exists in `cwd` — not whether the binary is in `$PATH`
  - The existing `ConfigLoader` reads `aes.config.json` but has no write path; a new `ConfigWriter` in the infra layer is required

## Research Log

### Interactive Prompt Library Selection

- **Context**: The wizard needs `select`, `text`, and `confirm` prompt types with Ctrl+C (cancel) detection.
- **Sources Consulted**: npm registry, Bun compatibility notes, project dependency philosophy (steering: no monolithic frameworks, minimal dependencies)
- **Findings**:
  - `@clack/prompts` (v0.7.x): lightweight, pure ESM, Bun-compatible, purpose-built for CLI wizards; provides `select`, `text`, `confirm`, `isCancel`, `intro`, `outro`
  - `@inquirer/prompts` (v12.x): more comprehensive but heavier; includes password input
  - `prompts` (v2.x): CJS-first, ESM wrapper can have issues with Bun strict ESM
  - Bun built-in readline: low-level, no select/menu support without manual implementation
- **Implications**: Use `@clack/prompts` — aligns with minimalism principle, provides all required types, native ESM, Bun-tested

### SDD Framework Check Logic

- **Context**: Req 3 requires checking whether the chosen SDD framework is "installed". The user defined cc-sdd as: `.kiro/` directory exists in project root.
- **Findings**:
  - `CcSddAdapter` invokes the `cc-sdd` binary via `Bun.spawn`. Being in PATH is assumed.
  - The "installation check" is explicitly about project-level setup (`.kiro/` directory), not binary availability.
  - `openspec` and `speckit` checks are undefined; must be designed as pluggable.
- **Implications**: `SddFrameworkChecker` must use a registry/strategy pattern so each framework has its own check function; cc-sdd check = `fs.access(join(cwd, '.kiro'))`.

### Config Write Path

- **Context**: `ConfigLoader.readConfigFile()` reads `join(cwd, 'aes.config.json')`. The writer must target the same path.
- **Findings**:
  - `ConfigLoader` accepts `cwd` as constructor argument; same pattern should be followed for `ConfigWriter`.
  - File write should use `node:fs/promises` `writeFile` with a JSON schema matching `RawConfig` (excluding `apiKey`).
  - Atomic write (write to temp + rename) is not strictly necessary given the low-risk CLI context; a direct `writeFile` with error propagation is sufficient.
- **Implications**: `ConfigWriter` is straightforward; the key contract is that it never writes `llm.apiKey`.

### Non-TTY Detection

- **Context**: Req 2.5 requires detecting non-interactive environments.
- **Findings**:
  - `@clack/prompts` automatically detects non-TTY and calls `process.exit(1)` with an appropriate message when prompts are not answered.
  - Explicit guard: check `process.stdin.isTTY` before launching wizard and exit with a clear message.
- **Implications**: Add `isTTY` guard in `ConfigureCommand` before running the wizard for a controlled, readable error message.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Flat wizard in CLI | All logic in `configure-command.ts` | Simple | Hard to test, mixes I/O with logic | Rejected |
| Wizard + Writer split | `ConfigWizard` (UI) + `ConfigWriter` (I/O) + `FrameworkChecker` (env) | Testable, single-responsibility | More files | **Selected** |
| Use Case layer for configure | Full use case in application layer | Consistent with other commands | Overkill; no domain logic involved | Rejected — no LLM or workflow involved |

## Design Decisions

### Decision: No Application Use Case for `configure`

- **Context**: Other commands (`run`) use the application use case layer. Should `configure` follow the same pattern?
- **Alternatives Considered**:
  1. Create `ConfigureUseCase` in `src/application/usecases/`
  2. Keep configure logic in the CLI layer only
- **Selected Approach**: CLI layer only. `ConfigureCommand` orchestrates `ConfigWizard`, `SddFrameworkChecker`, and `ConfigWriter` directly.
- **Rationale**: `configure` has no domain logic, no LLM calls, and no workflow state. It is pure I/O (prompts + file write). The application use case layer is for orchestrating domain behavior; a setup wizard does not qualify.
- **Trade-offs**: Slightly less uniform structure; acceptable given the clear rationale.

### Decision: `IConfigWriter` and `IFrameworkChecker` as Application Ports

- **Context**: Should `ConfigWriter` and `SddFrameworkChecker` expose application-layer interfaces?
- **Alternatives Considered**:
  1. Define interfaces in `src/application/ports/config.ts` (extending existing file)
  2. Define interfaces inline in CLI layer
- **Selected Approach**: Define `IConfigWriter` and `IFrameworkChecker` in `src/application/ports/config.ts`.
- **Rationale**: Allows the CLI layer to depend on abstractions (testable), and keeps the pattern consistent with how other ports (`IConfigLoader`) are defined.
- **Trade-offs**: Slightly more coupling between config port file and framework-check concerns; acceptable.

### Decision: `@clack/prompts` as the Prompt Library

- **Context**: No prompt library exists; wizard requires select lists and text input.
- **Selected Approach**: Add `@clack/prompts` as a production dependency.
- **Rationale**: Minimal, ESM-native, Bun-compatible, no sub-dependency sprawl.
- **Follow-up**: Verify version pinned to stable release; add to `package.json` dependencies.

## Risks & Mitigations

- **`@clack/prompts` Bun compatibility break** — Low risk; library is ESM-native. Pin to tested version.
- **SDD framework check definition for openspec/speckit** — Currently undefined. Design as pluggable registry with `unknown framework → skip check` as the safe default until checks are specified.
- **Partial write on process kill** — If `SIGKILL` hits between `ConfigWizard` returning and `ConfigWriter.write()`, no file is written (correct behavior). Direct `writeFile` is safe here.
- **Pre-population from env vars** — `ConfigLoader.mergeWithEnv()` merges file + env. The wizard pre-populates from the config file only (not env vars), keeping env vars as a runtime override mechanism separate from the persisted config.
