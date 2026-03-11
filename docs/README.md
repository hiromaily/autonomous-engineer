# Documentation Index

This index helps AI agents and developers quickly locate relevant documentation.

## Quick Reference

| Topic | File |
|---|---|
| Project vision & goals | [vision.md](vision.md) |
| System overview & components | [system-overview.md](system-overview.md) |
| Architecture principles & structure | [architecture/architecture.md](architecture/architecture.md) |
| AI Dev Agent v1 spec | [agent/dev-agent-v1.md](agent/dev-agent-v1.md) |
| **Spec breakdown & implementation plan** | **[agent/dev-agent-v1-specs.md](agent/dev-agent-v1-specs.md)** |
| Spec-driven workflow | [workflow/spec-driven-workflow.md](workflow/spec-driven-workflow.md) |
| Automation workflow (human vs. AI boundary) | [workflow/automation-workflow.md](workflow/automation-workflow.md) |
| Memory system design | [memory/memory-architecture.md](memory/memory-architecture.md) |
| Development environment setup | [development/development-environment.md](development/development-environment.md) |
| AI agent framework policy | [development/ai-agent-framework-policy.md](development/ai-agent-framework-policy.md) |
| Agent configuration methodology | [development/agent-configuration.md](development/agent-configuration.md) |

---

## Top-Level Documents

### [vision.md](vision.md)
Project vision: why autonomous engineering matters, the problems with current AI tools (stateless, no workflow orchestration, context explosion), and the solution roadmap across three versions — AI Dev Agent → AI Engineering Team → Autonomous Engineering Organization.

### [system-overview.md](system-overview.md)
High-level architecture overview with ASCII diagram. Describes all major subsystems: CLI, Workflow Engine, Spec Engine, Implementation Engine, Review Engine, LLM Provider Layer, Git Controller, Memory System, Self-Healing Mechanism, and Context Management.

---

## Architecture (`architecture/`)

### [architecture/architecture.md](architecture/architecture.md)
Layered architecture (CLI → Workflow → Domain → Adapter → Infrastructure), core modules, adapter pattern for SDD frameworks and LLM providers, memory integration, Git integration, Rust integration for performance-critical components, and the canonical directory structure.

### [architecture/agent-loop-architecture.md](architecture/agent-loop-architecture.md)
Design of the core agent execution loop — how the agent reasons, selects tools, executes actions, and iterates until task completion.

### [architecture/agent-safety-architecture.md](architecture/agent-safety-architecture.md)
Safety mechanisms for AI agent operations in the development environment — constraints, validation, and guardrails to prevent unsafe actions.

### [architecture/codebase-intelligence-architecture.md](architecture/codebase-intelligence-architecture.md)
The subsystem that enables the AI Dev Agent to understand and reason about a software repository — indexing, search, and code comprehension.

### [architecture/context-engineering-architecture.md](architecture/context-engineering-architecture.md)
How LLM context is constructed at each reasoning step — strategies for phase isolation, task isolation, artifact injection, and context pruning to maximize reasoning quality and minimize token usage.

### [architecture/task-planning-architecture.md](architecture/task-planning-architecture.md)
How complex engineering tasks are broken down into manageable steps — task decomposition, sequencing, and dependency tracking.

### [architecture/tool-system-architecture.md](architecture/tool-system-architecture.md)
The core execution layer of the AI Dev Agent — how tools are defined, registered, and invoked by the agent.

---

## Agent (`agent/`)

### [agent/dev-agent-v1.md](agent/dev-agent-v1.md)
Specification for the first practical implementation of the Autonomous Engineer system — capabilities, design decisions, and component interactions for v1.

---

## Workflow (`workflow/`)

### [workflow/spec-driven-workflow.md](workflow/spec-driven-workflow.md)
Spec-Driven Development (SDD) workflow: the phase-by-phase development process from `spec-init` through `requirements`, `design`, `validate-design`, `tasks`, `implementation`, to `pull-request`.

### [workflow/automation-workflow.md](workflow/automation-workflow.md)
Human vs. AI responsibility boundary: what humans do (initial docs + final PR review) versus what is fully automated (branch creation, spec generation, review loops, approvals, implementation, commits, PR creation). Includes Mermaid diagrams for the full flow, review loop, and implementation loop.

---

## Memory (`memory/`)

### [memory/memory-architecture.md](memory/memory-architecture.md)
Memory system design — short-term memory (single workflow execution), project memory (repository-specific conventions and patterns), and knowledge memory (reusable patterns extracted across development sessions).

---

## Development (`development/`)

### [development/development-environment.md](development/development-environment.md)
Development toolchain setup — runtime, package manager, language, build tools, and configuration for local development.

### [development/ai-agent-framework-policy.md](development/ai-agent-framework-policy.md)
Policy on intentionally avoiding large AI agent frameworks — rationale for building lightweight, custom components to maintain control, transparency, and minimal dependencies.

### [development/agent-configuration.md](development/agent-configuration.md)
Agent configuration methodology — how to configure which LLM provider and coding agent (Claude Code, Cursor, Codex, Copilot) to use, the configuration hierarchy (config file, env vars, CLI flags), per-agent native config integration, and dynamic per-phase provider selection.
