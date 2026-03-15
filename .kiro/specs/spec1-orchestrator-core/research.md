# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `orchestrator-core`
- **Discovery Scope**: New Feature (greenfield — no existing source code)
- **Key Findings**:
  - citty 0.2.1 is the most Bun-native CLI framework: zero dependencies, ESM-only, built on `node:util.parseArgs`
  - A custom discriminated-union state machine is preferable over XState for a 7-state CLI workflow: zero overhead, pure functions, exhaustive TypeScript checking
  - `@anthropic-ai/sdk 0.78.0` explicitly supports Bun 1.0+; `Bun.write()` alone is not crash-atomic — write-then-rename pattern is required for state persistence

---

## Research Log

### CLI Framework Selection

- **Context**: Need a Bun-native CLI framework for `aes run <spec-name>` with subcommands and typed flags
- **Sources Consulted**: npm registry, unjs/citty GitHub, Bloomberg Stricli docs, clipanion GitHub
- **Findings**:
  - **citty 0.2.1**: 24 KB unpacked, zero deps, ESM-only, TypeScript-native, built on `node:util.parseArgs` (Bun fully supports), `defineCommand` + `runMain` API
  - **commander 14.0.3**: 209 KB, `@types/` bolt-on, works in Bun via Node.js compat but not Bun-optimized
  - **yargs 18.0.0**: 231 KB, heavy transitive deps, not recommended for Bun-first projects
  - **clipanion 4.0.0-rc.4**: pre-release, class-based, no Bun docs, heavier boilerplate
- **Implications**: Use **citty** — smallest, zero-dep, runtime-agnostic, no caveats for Bun

### State Machine Implementation

- **Context**: Workflow Engine needs a 7-state machine with deterministic transitions, failure states, and approval pause states
- **Sources Consulted**: XState v5 npm, XState GitHub, Stately blog
- **Findings**:
  - **XState v5.28.0**: ~2.25 MB on disk (tree-shakeable), actor model, visual debugger, hierarchical states — valuable for UI state but heavy for CLI
  - **Custom discriminated union**: zero deps, pure `transition(state, event) → state` function, exhaustive `switch`/`never` TypeScript checking, trivially unit-testable
- **Implications**: Use **custom discriminated union**. For a CLI workflow with a fixed 7-phase sequence, XState's features (parallel regions, visualizer) provide no benefit. Revisit XState if the state machine grows hierarchical.

### Anthropic SDK Compatibility

- **Context**: LLM abstraction requires a `ClaudeProvider` implementation
- **Sources Consulted**: @anthropic-ai/sdk npm, Anthropic README, Bun Node.js compat docs
- **Findings**:
  - Package: `@anthropic-ai/sdk@0.78.0`, peer dep: `zod ^3.25.0 || ^4.0.0`
  - Bun 1.0+ is explicitly listed as a supported runtime
  - API: `client.messages.create({ model, max_tokens, messages })` → `Message` (contains `ContentBlock[]` + `Usage`)
  - Streaming: `stream: true` on `messages.create` or high-level `client.messages.stream()` helper
- **Implications**: Straightforward integration. Wrap in `ClaudeProvider` behind `LlmProviderPort`. Streaming capability exposed as optional interface method.

### EventEmitter for Progress Events

- **Context**: Workflow events (phase-start, phase-complete, error) must be emitted to CLI subscribers
- **Sources Consulted**: Bun Node.js compatibility table (official docs, March 2026)
- **Findings**:
  - `node:events` passes 100% of Node.js tests in Bun
  - No caveats for plain `EventEmitter` usage in a CLI context
- **Implications**: Use `node:events` `EventEmitter` as the `WorkflowEventBus` — no additional library needed

### State Persistence Atomicity

- **Context**: Workflow state must survive process crashes (SIGKILL between phase transitions)
- **Sources Consulted**: Bun file I/O docs, crash-safe JSON patterns (dev.to)
- **Findings**:
  - `Bun.write(path, content)` maps to a plain `write()` syscall — **not crash-atomic**; a crash mid-write leaves a corrupted file
  - **Write-then-rename** is the POSIX-standard atomic pattern: write to `<same-dir>/.tmp-<random>`, `datasync()`, then `rename()` over the destination — `rename()` is atomic on POSIX when source and destination are on the same filesystem
  - `node:fs` (`open`, `datasync`, `rename`) is 92%+ implemented in Bun
- **Implications**: `WorkflowStateStore` must implement write-then-rename, not bare `Bun.write()`

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Clean + Hexagonal (selected) | Ports & adapters around domain core; CLI → Use Case → Domain → Adapter → Infra | Matches steering; swappable adapters (cc-sdd → OpenSpec); testable domain without I/O | More files than a flat design | Required by project steering |
| Flat procedural | Single-file or multi-file scripts with direct SDK calls | Fast to write | Zero testability; no adapter swappability; violates steering | Rejected |
| Event-sourced workflow | Append-only event log drives state | Full history, replay | Overkill for a CLI tool; complex recovery logic | Rejected for v1; revisit for multi-agent future |

---

## Design Decisions

### Decision: Custom State Machine over XState

- **Context**: Workflow Engine needs a state machine for 7 phases + failure + approval pause
- **Alternatives Considered**:
  1. XState v5 — full actor model, visual debugger, hierarchical states, ~2.25 MB
  2. Custom discriminated union — zero deps, pure function `transition(state, event) → state`
- **Selected Approach**: Custom discriminated union with exhaustive `switch` on `WorkflowPhase`
- **Rationale**: CLI tool; 7 phases are a flat linear sequence; no parallel states; no visual debugging needed; pure functions are trivially testable
- **Trade-offs**: No built-in visual debugging; must implement guards and history manually
- **Follow-up**: Evaluate XState if spec11 (codebase-intelligence) introduces complex concurrent workflows

### Decision: citty for CLI Framework

- **Context**: CLI entry point needs subcommand handling and typed flag parsing for Bun
- **Alternatives Considered**:
  1. citty 0.2.1 — 24 KB, zero deps, ESM-native
  2. commander 14.x — battle-tested but 209 KB, `@types/` bolt-on
- **Selected Approach**: citty with `defineCommand` + `subCommands`
- **Rationale**: Smallest footprint, ESM-only, built on `node:util.parseArgs` which Bun natively supports; aligns with lightweight toolchain preference
- **Trade-offs**: Pre-1.0 API stability; may require version pin
- **Follow-up**: Pin citty to `0.2.1`; review API at citty `1.0` when released

### Decision: Approval Gates as Workflow State (not external signals)

- **Context**: Human approval at requirements/design/tasks boundaries must halt and resume the workflow
- **Alternatives Considered**:
  1. Polling `spec.json` on a timer — adds complexity, not CLI-appropriate
  2. PAUSED_FOR_APPROVAL state — workflow halts to a persisted state; next `aes run` re-reads `spec.json` and advances if approved
- **Selected Approach**: `PAUSED_FOR_APPROVAL` is a persisted state; the workflow resumes naturally on the next `aes run` or `aes run --resume` invocation
- **Rationale**: CLI tools are run-to-completion; a persistent pause state is idiomatic; no daemon or long-lived process needed
- **Trade-offs**: User must re-run the command after approving; no in-process notification
- **Follow-up**: Consider a `aes status` subcommand in a follow-up spec to show current state without running

### Decision: Write-then-Rename for State Persistence

- **Context**: `WorkflowState` must survive SIGKILL between phase transitions
- **Selected Approach**: `Bun.write(tmpPath, json)` + `fd.datasync()` + `fs.rename(tmpPath, statePath)` in same directory
- **Rationale**: POSIX `rename()` is atomic on same-filesystem; `Bun.write()` alone is not crash-safe
- **Trade-offs**: Slightly more complex write path; marginal performance overhead from `datasync()`
- **Follow-up**: Test on macOS APFS (copy-on-write) and Linux ext4

---

## Risks & Mitigations

- **citty API stability** — pre-1.0 library may change APIs; pin to `0.2.1` and run `bun audit` on upgrades
- **cc-sdd command interface drift** — cc-sdd CLI flags may change; isolate all invocations inside `CcSddAdapter`; write adapter integration tests against cc-sdd subprocess directly
- **Claude API rate limits** — `@anthropic-ai/sdk` does not auto-retry; `ClaudeProvider` must detect `rate_limit` category and propagate it; retry logic deferred to spec4 (agent-loop)
- **State file corruption on macOS APFS** — `rename()` atomicity is guaranteed by the OS even on APFS; low risk
- **Spec.json approval race** — if user manually edits `spec.json` during a running workflow, the next phase check may see stale data; mitigated by reading `spec.json` fresh at each transition

---

## References

- [citty — GitHub (unjs/citty)](https://github.com/unjs/citty)
- [@anthropic-ai/sdk — npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat)
- [Bun File I/O](https://bun.sh/docs/api/file-io)
- [XState v5 — Stately blog](https://stately.ai/blog/2023-12-01-xstate-v5)
- [Crash-safe JSON atomic writes](https://dev.to/constanta/crash-safe-json-at-scale-atomic-writes-recovery-without-a-db-3aic)
