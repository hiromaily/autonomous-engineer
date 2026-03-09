# AI Agent Framework Policy

## Overview

This project intentionally avoids using large AI agent frameworks such as:

- LangChain
- AutoGPT-style frameworks
- CrewAI
- Semantic Kernel
- other monolithic agent frameworks

Instead, the system implements its own **lightweight agent architecture**.

This decision is deliberate and based on several architectural considerations.

---

## Reason 1: Architectural Control

Most agent frameworks impose their own architecture.

Typical examples include:

- chain-based execution models
- opaque memory systems
- framework-specific tool interfaces
- hidden prompt orchestration

For a system designed to build software autonomously, **full control over the execution architecture is required**.

By implementing the core systems internally, the project can define:

- its own tool system
- its own memory architecture
- its own workflow engine
- its own context management

This allows the system to evolve without framework constraints.

---

## Reason 2: Stability

AI agent frameworks evolve extremely quickly.

Major breaking changes often occur every few months.

Examples observed in the ecosystem include:

- LangChain architecture changes
- frequent API redesigns
- dependency instability
- experimental features becoming deprecated

For a long-lived autonomous engineering system, **stable architecture is more important than rapid framework iteration**.

Avoiding framework lock-in improves long-term maintainability.

---

## Reason 3: Simplicity

Most frameworks introduce significant complexity:

- large dependency trees
- heavy abstraction layers
- unclear execution flows
- difficult debugging

Autonomous Engineer prioritizes **simple and explicit system design**.

Instead of a framework, the system directly implements:

- tool execution
- memory retrieval
- workflow orchestration
- context construction

This makes the system easier to reason about and easier for AI agents to modify.

---

## Reason 4: AI-Optimized Architecture

Traditional frameworks were designed primarily for:

- chat agents
- RAG pipelines
- simple tool usage

This project is building an **autonomous software engineer**.

Such a system requires specialized capabilities:

- spec-driven development workflows
- repository-level reasoning
- long-term engineering memory
- deterministic tool execution
- codebase-scale context management

These requirements differ significantly from typical agent frameworks.

Building the architecture directly enables designs optimized for autonomous development.

---

## Reason 5: Framework Independence

The system should remain independent from specific AI providers or frameworks.

Supported model providers may include:

- OpenAI
- Anthropic
- local models
- future providers

Similarly, the architecture should remain compatible with:

- different agent strategies
- different model capabilities
- future improvements in AI tooling

Avoiding framework lock-in preserves this flexibility.

---

## What the System Still Uses

Although the project avoids large agent frameworks, it still uses libraries where appropriate.

Examples may include:

- OpenAI SDKs
- embedding libraries
- vector databases
- tokenizer libraries

The goal is to avoid **agent orchestration frameworks**, not to avoid useful libraries.

---

## Summary

Autonomous Engineer deliberately avoids using large AI agent frameworks.

Instead, the system implements its own architecture for:

- tool execution
- workflow orchestration
- memory systems
- context management

This approach provides:

- architectural control
- long-term stability
- simpler execution models
- flexibility for future AI capabilities
