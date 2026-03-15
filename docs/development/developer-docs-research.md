# Developer Documentation Research Report

## Overview

This report identifies existing developer documentation, gaps, and recommendations for building out `docs/development/` into a complete contributor knowledge base.

Tracked in: [GitHub Issue #23](https://github.com/hiromaily/autonomous-engineer/issues/23)

---

## Part 1: Existing Documentation

### `docs/development/` (current files)

| File | Status | Summary |
|---|---|---|
| `development-environment.md` | Complete | Toolchain: Bun v1.3.10, TypeScript 5.9.3, Biome, dprint, Anthropic SDK |
| `ai-agent-framework-policy.md` | Complete | Why monolithic frameworks (LangChain, etc.) are avoided |
| `agent-configuration.md` | Complete | LLM provider config, env vars, per-phase override |
| `cli-reference.md` | Complete | `aes run` command, workflow phases, approval gates, exit codes |
| `debugging.md` | Complete | Log layers, `--log-json`, `.aes/logs/`, `.aes/state/`, memory files |
| `workflow-customization.md` | Complete | Which files to modify when adjusting the workflow |

All files have Japanese mirrors under `docs/ja/development/`.

### Related documentation (referenced by dev docs)

| Location | Content |
|---|---|
| `docs/architecture/` | 7 architecture documents covering system design layers |
| `docs/memory/memory-architecture.md` | Memory system abstract design |
| `docs/workflow/spec-driven-workflow.md` | SDD phase workflow |
| `CLAUDE.md` | Project rules for Claude Code |
| `.kiro/steering/` | Persistent project memory (product.md, tech.md, structure.md) |

### Toolchain configuration files

| File | Purpose |
|---|---|
| `orchestrator-ts/package.json` | Scripts: `test`, `typecheck`, `fmt`, `lint`, `build` |
| `orchestrator-ts/tsconfig.json` | Strict TypeScript with `@/*` path alias |
| `orchestrator-ts/biome.json` | Biome linter config |
| `orchestrator-ts/dprint.json` | dprint formatter config |
| `lefthook.yml` | Pre-commit hook: `make ts-lint` |
| `.github/workflows/docs.yml` | CI: VitePress deploy to GitHub Pages |

---

## Part 2: Gaps

### P1 — Critical (blocks contributor onboarding)

**Quickstart** (`quickstart.md`)
- `development-environment.md` explains toolchain but there is no single "clone → working" guide
- Missing: step-by-step `bun install`, verifying CLI works locally, what `.aes/` / `.memory/` / `.kiro/` directories are created during dev, lefthook setup

**Testing guide** (`testing-guide.md`)
- `orchestrator-ts/tests/` has unit / integration / e2e subdirectories with real tests
- Zero documentation on how to run tests, test organization, mocking strategy for LLM/Git/filesystem, or coverage expectations

**Contributing guide** (`contributing.md`)
- No branch naming convention, commit message standard, PR checklist, or guidance on when to create a spec vs. open a direct PR

**Code structure** (`code-structure.md`)
- Architecture docs explain abstract layering; nothing explains the concrete Clean Architecture layout in `orchestrator-ts/src/` (cli / application / domain / adapters / infra), the port/adapter pattern in code, or the `@/*` path alias

---

### P2 — Important (needed once contributing)

**Implementing adapters** (`implementation/implementing-adapters.md`)
- No guide on how to add a new LLM provider, SDD framework, or tool; the pattern is consistent (implement a port interface in `adapters/`) but undocumented

**Domain layer guide** (`implementation/domain-layer-guide.md`)
- No explanation of business rule organization, state machines (`WorkflowState`, `AgentState`), discriminated union patterns, or how to extend domain types safely

**Tool system reference** (`implementation/tool-system.md`)
- `docs/architecture/tool-system-architecture.md` covers abstract design; nothing covers the existing tool inventory (filesystem, shell, git, code-analysis, knowledge) or how to add a new tool with safety constraints

**Git integration internals** (`implementation/git-integration.md`)
- No explanation of feature branch creation, commit strategy (atomic per task section), PR generation, or GitHub token setup for local development

**Memory system internals** (`implementation/memory-system-implementation.md`)
- `docs/memory/memory-architecture.md` is abstract; no guide on how `.memory/` is populated during runs, when to edit memory files, or how failure records feed agent behavior

**Deep debugging** (`implementation/deep-debugging.md`)
- `debugging.md` covers log files; missing: debugging by layer, tracing LLM prompt/response pairs, tool execution failures, workflow phase hangs, Bun debugger usage

---

### P3 — Advanced (for maintainers and specialized contributors)

**TypeScript patterns** (`advanced/type-safety-patterns.md`)
- `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` are configured but not documented; no guide to Result/Either error handling, branded types, or exhaustive discriminated unions

**Performance and profiling** (`advanced/performance-and-profiling.md`)
- No guide to token budget monitoring, agent loop NDJSON analysis, or when to introduce Rust (`memory-rs`)

**Deployment and distribution** (`advanced/deployment-and-distribution.md`)
- `bun build` produces a binary but no guide for builds, NPM publication, or GitHub releases

**SDD framework adapters** (`implementation/sdd-framework-adapters.md`)
- No guide on how `cc-sdd-adapter.ts` works or how to add `openspec` / `speckit` support

---

### CI/CD gap

The only workflow is `.github/workflows/docs.yml` (VitePress deploy). There is no CI for tests, linting, or type-checking. Two workflows are needed:

- `.github/workflows/test.yml` — lint + typecheck + `bun test` on every PR
- `.github/workflows/release.yml` — build binary and publish on release

---

## Part 3: Recommended Directory Structure

```
docs/development/
├── quickstart.md                          NEW (P1)
├── contributing.md                        NEW (P1)
├── testing-guide.md                       NEW (P1)
├── code-structure.md                      NEW (P1)
├── workflow-customization.md              existing
├── cli-reference.md                       existing
├── debugging.md                           existing
├── development-environment.md             existing
├── agent-configuration.md                 existing
├── ai-agent-framework-policy.md           existing
│
├── implementation/
│   ├── implementing-adapters.md           NEW (P2)
│   ├── domain-layer-guide.md             NEW (P2)
│   ├── tool-system.md                    NEW (P2)
│   ├── git-integration.md               NEW (P2)
│   ├── memory-system-implementation.md   NEW (P2)
│   ├── deep-debugging.md                 NEW (P2)
│   └── sdd-framework-adapters.md         NEW (P3)
│
└── advanced/
    ├── type-safety-patterns.md            NEW (P3)
    ├── performance-and-profiling.md       NEW (P3)
    └── deployment-and-distribution.md    NEW (P3)
```

`docs/ja/development/` mirrors the same structure (bilingual requirement).

---

## Part 4: Document Specs

### `quickstart.md` (P1)
Key sections: system requirements → clone + `bun install` → verify with `bun run typecheck` and `bun test` → run CLI with `bun run aes` → lefthook pre-commit setup → what runtime directories are created → where to go next.

### `contributing.md` (P1)
Key sections: branch naming (`feature/`, `fix/`, `docs/`, `refactor/`), commit message convention, when to create a spec vs. direct PR, PR checklist (lint + typecheck + tests pass), merge strategy.

### `testing-guide.md` (P1)
Key sections: running tests (`bun test`, `--watch`, filtered), test organization (mirrors `src/`), unit vs. integration vs. e2e boundaries, mocking strategy (LLM / filesystem / Git), fixture patterns, naming conventions.

### `code-structure.md` (P1)
Key sections: Clean Architecture layers in `orchestrator-ts/src/`, dependency flow, port/adapter pattern with concrete code examples, `@/*` path alias, "trace a feature through all layers" walkthrough.

### `implementation/implementing-adapters.md` (P2)
Key sections: step-by-step adding a new LLM provider (using `ClaudeProvider` as reference), adding a new tool, adding a new SDD framework adapter; testing each type.

### `implementation/domain-layer-guide.md` (P2)
Key sections: no-external-deps constraint, key entities and state machines, discriminated union patterns, error types, extending domain types safely, pure-function testing.

### `implementation/tool-system.md` (P2)
Key sections: tool inventory (filesystem, shell, git, code-analysis, knowledge), tool executor pipeline (validate → execute → audit log), safety constraints, how to add a new tool.

### `implementation/git-integration.md` (P2)
Key sections: feature branch creation and naming, atomic commit strategy, protected branch checks, PR generation, GitHub token setup.

### `implementation/memory-system-implementation.md` (P2)
Key sections: `.memory/` file types and structure, how memory is populated during runs, failure records, when and how to manually edit memory, effect on LLM prompt context.

### `implementation/deep-debugging.md` (P2)
Key sections: debugging by layer (CLI / Application / Domain / Adapters / Infra), tracing LLM prompts and responses, tool execution failures, workflow phase hangs, Bun debugger, NDJSON log analysis with `jq`.

### `advanced/type-safety-patterns.md` (P3)
Key sections: `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` with examples, Result/Either error handling, discriminated unions, branded types, exhaustiveness with `never`.

### `advanced/performance-and-profiling.md` (P3)
Key sections: token budget monitoring, NDJSON log analysis for iteration timing and count, optimization strategies (context pruning, memory relevance), Rust component introduction criteria.

### `advanced/deployment-and-distribution.md` (P3)
Key sections: `bun build` output, `bun link` for local dev, NPM publication, GitHub release assets, versioning.

---

## Part 5: Acceptance Criteria

- [ ] P1 documents created in English and Japanese
- [ ] P2 documents created in English and Japanese
- [ ] P3 documents created in English and Japanese
- [ ] VitePress navigation updated for all new documents and subdirectories
- [ ] `.github/workflows/test.yml` added
- [ ] A new developer can complete quickstart in under 15 minutes
