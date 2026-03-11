# Development Environment

## Overview

Autonomous Engineer uses a modern development toolchain designed for performance, consistency, and compatibility with AI-assisted development.

The environment prioritizes:

- deterministic builds
- fast execution
- minimal tooling complexity
- compatibility with TypeScript and Rust

This document defines the officially supported development environment for the project.

---

## Runtime and Package Manager

The project uses **Bun** as both the runtime and package manager.

Bun provides a high-performance JavaScript runtime with built-in tooling for package management, script execution, and TypeScript support.

Version used in this project:

```
bun v1.3.10
```

Official website:

https://bun.sh

Key reasons for choosing Bun:

- extremely fast startup and execution
- built-in package manager
- native TypeScript support
- compatibility with Node.js ecosystem
- simplified tooling compared to Node + npm/pnpm

All project scripts should be executed using Bun.

Example:

```
bun install
bun run build
bun run dev
```

---

## TypeScript

The primary language of the system is TypeScript.

Version:

```
TypeScript 5.9.3
```

TypeScript is used for:

- core system logic
- workflow engine
- AI orchestration
- CLI interface
- adapter implementations

Recommended compiler configuration:

```
strict: true
noUncheckedIndexedAccess: true
exactOptionalPropertyTypes: true
```

These settings improve type safety and reduce runtime errors.

---

## Rust

Rust is used for performance-critical components.

Rust modules may be responsible for:

- memory indexing
- semantic search
- context filtering
- knowledge retrieval

Rust edition used in this project:

```
Rust 2024 Edition
```

Rust components may be integrated with the TypeScript system using:

- napi-rs
- WebAssembly

This allows high-performance operations while keeping most system logic in TypeScript.

---

## TypeScript vs Rust: Division of Roles

TypeScript and Rust serve distinct purposes in the system.

| Concern | TypeScript | Rust |
|---|---|---|
| Core business logic | ✓ | |
| Workflow orchestration | ✓ | |
| AI/LLM interaction | ✓ | |
| CLI interface | ✓ | |
| Adapter implementations | ✓ | |
| Memory indexing | | ✓ |
| Semantic search | | ✓ |
| Context diffing | | ✓ |
| Knowledge retrieval | | ✓ |

The general rule: implement in TypeScript first. Migrate to Rust only when performance profiling identifies a concrete bottleneck.

---

## Linting

Linting is performed using **Biome**.

Biome is a Rust-based tool that provides fast and reliable linting for JavaScript and TypeScript.

Tool:

```
biome
```

Reasons for choosing Biome:

- written in Rust
- significantly faster than traditional linters
- unified linting ecosystem
- modern JavaScript support

Biome is responsible for detecting:

- code quality issues
- unsafe patterns
- stylistic inconsistencies

---

## Formatting

Code formatting is performed using **dprint**.

Tool:

```
dprint
```

Reasons for choosing dprint:

- written in Rust
- extremely fast
- deterministic formatting
- stable formatting rules

dprint ensures that code formatting remains consistent across the repository.

---

## Package Management

Dependency management is handled by Bun.

Example commands:

Install dependencies:

```
bun install
```

Add dependency:

```
bun add <package>
```

Run scripts:

```
bun run <script>
```

Using Bun simplifies dependency management compared to traditional Node environments.

---

## Anthropic AI SDK

The project integrates with Claude models via the official Anthropic SDK for TypeScript.

Version used in this project:

```
@anthropic-ai/sdk 0.78.0
```

This version provides:

- explicit Bun 1.0+ runtime support
- `zod ^3.25.0` as a peer dependency (also a direct runtime dependency)
- the `client.messages.create()` API used by the Claude provider adapter

The SDK is installed as a runtime dependency:

```
bun add @anthropic-ai/sdk
```

---

## Repository Structure

The project uses a `<responsibility>-<lang-suffix>` naming convention for implementation directories (e.g., `orchestrator-ts/`, `memory-rs/`). Each directory is a self-contained component with its own toolchain.

See [Architecture — Directory Structure](/architecture/architecture#directory-structure) for the full canonical structure and naming convention rationale.

```
autonomous-engineer/
├─ orchestrator-ts/      # Workflow orchestration engine + aes CLI (TypeScript/Bun)
│  ├─ cli/
│  ├─ application/
│  ├─ domain/
│  ├─ adapters/
│  ├─ infra/
│  ├─ tests/
│  ├─ package.json
│  └─ tsconfig.json
│
├─ docs/
└─ README.md
```

Within `orchestrator-ts/`, the structure maps directly to Clean Architecture layers, keeping core logic independent from external dependencies.

---

## Development Philosophy

The development environment is designed to support AI-assisted development.

Key principles include:

### Fast Feedback Loops

Tooling must be fast to support frequent AI-generated changes.

### Deterministic Output

Formatting and linting must produce consistent results.

### Minimal Configuration

Tooling complexity should be minimized to reduce friction for both developers and AI agents.

### AI-Friendly Structure

Clear structure and deterministic tooling help AI systems generate better code.

---

## Summary

The Autonomous Engineer development environment is built around modern, high-performance tools.

Core technologies include:

```
Runtime: Bun v1.3.10
Language: TypeScript 5.9.3
Systems Language: Rust (Edition 2024)
Linter: Biome
Formatter: dprint
AI SDK: @anthropic-ai/sdk 0.78.0
```

This stack provides a fast, consistent, and AI-friendly development environment for building autonomous engineering systems.
