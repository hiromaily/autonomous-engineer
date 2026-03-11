# Agent Configuration Methodology

## Overview

Autonomous Engineer supports multiple coding agents and LLM providers through a unified adapter interface.

Each agent (Claude Code, Cursor, Codex, GitHub Copilot) has its own native configuration format, capabilities, and integration model.

This document describes:

- how to configure which agent and provider to use
- the configuration hierarchy and schema
- per-agent native configuration integration
- dynamic and per-phase configuration

---

## Configuration Hierarchy

Configuration is resolved in the following order (highest priority first):

```
CLI flags
↓
Environment variables
↓
Project config file (aes.config.ts)
↓
Default values
```

Each level overrides the previous one, allowing fine-grained control in different environments.

---

## Project Configuration File

The primary configuration file is `aes.config.ts` at the project root.

Example:

```ts
import { defineConfig } from "autonomous-engineer";

export default defineConfig({
  agent: {
    provider: "claude",       // Active LLM provider
    model: "claude-opus-4-6", // Model identifier
  },

  sdd: {
    framework: "cc-sdd",      // Active SDD framework adapter
  },

  workflow: {
    phases: {
      design: {
        provider: "claude",   // Phase-specific provider override
      },
      implementation: {
        provider: "codex",    // Different provider for implementation
      },
    },
  },
});
```

The config file is optional. When absent, defaults are applied.

---

## Environment Variables

Provider and model can be configured through environment variables.

| Variable | Description | Example |
|---|---|---|
| `AES_PROVIDER` | Active LLM provider | `claude`, `codex`, `cursor`, `copilot` |
| `AES_MODEL` | Model identifier | `claude-opus-4-6` |
| `AES_SDD_FRAMEWORK` | Active SDD framework | `cc-sdd`, `openspec` |
| `ANTHROPIC_API_KEY` | API key for Anthropic/Claude | `sk-ant-...` |
| `OPENAI_API_KEY` | API key for OpenAI/Codex | `sk-...` |

Environment variables are useful for CI/CD environments and local overrides without modifying the config file.

---

## CLI Flags

Provider and model can be overridden per-command via CLI flags.

```sh
aes run <spec-name> --provider claude --model claude-opus-4-6
aes run <spec-name> --provider codex --model gpt-4o
```

This is useful when running the same spec with different providers for comparison.

---

## Supported Providers

The following LLM providers are supported through the adapter interface.

| Provider | Identifier | Description |
|---|---|---|
| Claude (Anthropic) | `claude` | Claude model family via Anthropic API |
| Codex (OpenAI) | `codex` | OpenAI model family via OpenAI API |
| Cursor | `cursor` | Cursor AI via Cursor agent interface |
| GitHub Copilot | `copilot` | GitHub Copilot via Copilot API |

Additional providers can be added by implementing the `LLMProvider` interface in `adapters/llm/`.

---

## Per-Agent Native Configuration

Each coding agent has its own native configuration format.

Autonomous Engineer generates and manages these files automatically based on the active agent and project context.

### Claude Code

Claude Code reads project-specific rules from:

- `CLAUDE.md` — project instructions and development rules
- `.claude/settings.json` — tool permissions and behavior settings
- `.claude/rules/` — modular rule files loaded by CLAUDE.md

Example CLAUDE.md managed by Autonomous Engineer:

```md
# Project Rules

## Development Guidelines
- Follow spec-driven development workflow
- All changes must align with the active specification
- Run tests before committing

## Architecture
- Follow Clean Architecture layer boundaries
- Use dependency injection for all adapters
```

### Cursor

Cursor reads rules from:

- `.cursor/rules/` — directory containing `.mdc` rule files

Example `.cursor/rules/project.mdc`:

```md
---
alwaysApply: true
---

Follow spec-driven development workflow.
All implementation must align with the active specification in .kiro/specs/.
```

### GitHub Copilot

GitHub Copilot reads repository instructions from:

- `.github/copilot-instructions.md` — repository-level instructions

Example:

```md
This project follows spec-driven development using Autonomous Engineer.
Always check .kiro/specs/ for the active specification before implementing.
Follow the Clean Architecture layer structure in the codebase.
```

### Codex (OpenAI)

Codex can be configured via:

- `AGENTS.md` — agent-level instructions at the project root
- Environment-specific system prompt overrides

Example `AGENTS.md`:

```md
# Codex Agent Instructions

This project uses spec-driven development.
Before implementing, review the active specification in .kiro/specs/.
Follow the directory structure and architecture defined in docs/architecture/.
```

---

## Dynamic Configuration

### Per-Phase Provider Selection

Different providers can be assigned to different workflow phases.

This allows using specialized models for specific tasks.

Example configuration:

```ts
workflow: {
  phases: {
    requirements: { provider: "claude" },
    design:       { provider: "claude" },
    implementation: { provider: "codex" },
    review:       { provider: "claude" },
  },
},
```

This strategy allows matching provider strengths to phase requirements.

### Runtime Switching

The active provider can be switched between runs without modifying the config file.

```sh
# Run with Claude
AES_PROVIDER=claude aes run <spec-name>

# Run the same spec with Codex
AES_PROVIDER=codex aes run <spec-name>
```

This is useful for comparing outputs across providers.

---

## Native Config Synchronization

When the active agent changes, Autonomous Engineer can regenerate agent-native config files.

```sh
aes sync-agent-config --provider cursor
```

This command:

1. reads the current project rules from `.kiro/steering/`
2. generates agent-specific config files for the target provider
3. updates files such as `.cursor/rules/`, `CLAUDE.md`, or `AGENTS.md`

This ensures agent-specific files remain consistent with project steering documents.

---

## Summary

| Concern | Mechanism |
|---|---|
| Active provider | `aes.config.ts`, env vars, CLI flags |
| Model selection | `aes.config.ts`, env vars, CLI flags |
| Per-phase providers | `aes.config.ts` workflow.phases |
| Agent-native rules | Auto-generated from `.kiro/steering/` |
| Provider interface | `adapters/llm/` implementations |

This configuration system ensures the workflow engine remains provider-independent while giving users full control over which agent runs each phase.
