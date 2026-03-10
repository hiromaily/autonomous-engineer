# Architecture

## Overview

Autonomous Engineer is designed as a modular system that orchestrates AI-driven software development workflows.

The architecture emphasizes:

- modularity
- clear boundaries
- extensibility
- minimal coupling
- provider abstraction

The system follows principles inspired by **Clean Architecture** and **Hexagonal Architecture**, allowing core logic to remain independent from external tools and providers.

This ensures that the system can evolve without major architectural rewrites.

---

## Architectural Principles

The architecture follows several guiding principles.

### Separation of Concerns

Each module should have a clearly defined responsibility.

Examples:

- workflow orchestration
- specification generation
- task execution
- AI interaction
- repository management

Modules should not take on responsibilities outside their domain.

---

### Dependency Inversion

Core system logic must not depend directly on infrastructure implementations.

Instead, dependencies should be defined as interfaces and implemented by adapters.

For example:

```
Core Logic
↓
Interfaces
↓
Adapters
↓
External Systems
```

External systems include:

- AI providers
- Git repositories
- SDD frameworks
- file systems

---

### Replaceable Infrastructure

Infrastructure components must be replaceable without changing core logic.

Examples:

- different LLM providers
- different specification systems
- different memory backends

---

### Minimal Context Surfaces

AI interactions should receive only the minimal necessary context.

This improves reasoning quality and reduces token consumption.

---

## Clean Architecture

The system is organized into several layers.

```
┌───────────────────────────────┐
│             CLI               │
│        User Interface         │
└───────────────┬───────────────┘
│
▼

┌───────────────────────────────┐
│       Use Case Layer          │
│  Application Business Rules   │
│  & Development Orchestration  │
└───────────────┬───────────────┘
│
▼

┌───────────────────────────────┐
│        Domain Layer           │
│      Core System Logic        │
└───────────────┬───────────────┘
│
▼

┌───────────────────────────────┐
│        Adapter Layer          │
│     External System Bridges   │
└───────────────┬───────────────┘
│
▼

┌───────────────────────────────┐
│      Infrastructure Layer     │
│  External Services & Tools    │
└───────────────────────────────┘
```

Each layer has strict responsibilities.

### Use Case Layer

The Use Case Layer encodes application-specific business rules and orchestrates development workflows.

In this system, workflow orchestration (driving phases such as spec-init → requirements → design → tasks → implementation) is itself a use case concern — it coordinates domain entities to fulfill application goals without depending on UI, frameworks, or external systems.

Responsibilities:

- orchestrate development lifecycle phases
- coordinate domain entities to fulfill a single application goal
- enforce business constraints specific to each use case
- remain independent of UI, frameworks, and external systems

Examples:

- `InitializeSpecUseCase` — drives the spec initialization flow
- `ExecuteTaskUseCase` — manages the implement → review → improve → commit loop
- `ValidateDesignUseCase` — coordinates design validation across reviewers

Use cases depend only on domain interfaces, never on adapters or infrastructure directly.

---

## Core Modules

The Domain Layer contains the core system modules.

### Workflow Engine

Responsible for orchestrating the development lifecycle.

Key responsibilities:

- phase transitions
- execution coordination
- workflow state management

Example phases:

```
spec-init
requirements
design
validate-design
tasks
implementation
pull-request
```

The workflow engine operates as a **state machine**.

---

### Spec Engine

Handles interactions with specification frameworks.

Responsibilities:

- initialize specifications
- generate requirements
- create designs
- validate designs
- generate tasks

The spec engine does not directly depend on any specific framework.

---

### Implementation Engine

Responsible for executing generated tasks.

Each task is processed through an iterative loop.

```
Implement
↓
Review
↓
Improve
↓
Commit
```

This loop continues until the task satisfies quality conditions.

---

### Review Engine

Evaluates artifacts generated during the workflow.

Examples include:

- design validation
- code review
- architecture consistency checks
- requirement compliance

The review engine ensures outputs remain aligned with specifications.

---

### Self-Healing Engine

Analyzes cases where AI execution fails or becomes inefficient.

Responsibilities:

- failure analysis
- identifying missing rules
- updating system knowledge

Outputs may include updates to:

```
rules/
implementation_rules.md
review_rules.md
debugging_patterns.md
```

This enables long-term system improvement.

---

## Adapter Pattern

External integrations are implemented using adapters.

Adapters translate core system operations into provider-specific implementations.

Example structure:

```
SpecEngine Interface

├── CCSddAdapter
├── OpenSpecAdapter
└── SpecKitAdapter
```

Similarly for AI providers:

```
LLMProvider Interface

├── ClaudeProvider
├── CodexProvider
├── CursorProvider
└── CopilotProvider
```

This ensures the core system remains independent of external technologies.

---

## Workflow Architecture

Workflows are deterministic and phase-based.

Example workflow:

```
SPEC_INIT
↓
REQUIREMENTS
↓
DESIGN
↓
VALIDATE_DESIGN
↓
TASK_GENERATION
↓
IMPLEMENTATION
↓
PULL_REQUEST
```

Each phase invokes specific engines.

Example mapping:

```
SPEC_INIT → Spec Engine
REQUIREMENTS → Spec Engine
DESIGN → Spec Engine
TASKS → Spec Engine
IMPLEMENTATION → Implementation Engine
REVIEW → Review Engine
```

The workflow engine controls transitions and ensures correct ordering.

---

## Memory Architecture Integration

The system integrates persistent memory for learning and context reuse.

Memory is divided into several layers.

### Short-Term Memory

Used during a single workflow execution.

Examples:

- current spec
- current tasks
- design artifacts

---

### Project Memory

Knowledge specific to the repository.

Examples:

- coding conventions
- architectural patterns
- review feedback

---

### Knowledge Memory

Reusable patterns discovered during development.

Examples:

- debugging strategies
- implementation templates
- rule improvements

Memory enables the system to evolve over time.

---

## LLM Integration

AI models are accessed through the LLM Provider interface.

The provider abstraction manages:

- prompt execution
- response parsing
- context control
- provider-specific APIs

Example interface:

```
LLMProvider

complete(prompt)
clearContext()
```

This design ensures that different AI systems can be used without changing core logic.

---

## Context Management

Effective context management is critical for LLM reliability.

The system enforces several strategies.

### Phase Isolation

Context is reset when entering a new workflow phase.

### Task Isolation

Each task section runs with minimal context.

### Artifact Injection

Only relevant documents are included in prompts.

Examples:

- spec documents
- design documents
- relevant source files

These strategies minimize token consumption and reduce reasoning errors.

---

## Git Integration

Git operations are performed through a dedicated controller.

Responsibilities include:

- branch creation
- committing changes
- pushing updates
- pull request creation

Example automated flow:

```
create feature branch
implement tasks
commit changes
push branch
create pull request
```

This enables end-to-end automated development workflows.

---

## Rust Integration

Certain components may require higher performance than JavaScript environments provide.

Rust may be used for:

- memory indexing
- semantic search
- context diffing
- knowledge retrieval

Rust modules can be integrated using:

- napi-rs
- WebAssembly

Example architecture:

```
TypeScript Core
│
▼
Rust Memory Engine
```

This allows performance-critical operations to scale efficiently.

---

## Extensibility

The architecture is designed for long-term extensibility.

Future extensions may include:

### Multi-Agent Systems

Different agents specializing in different tasks.

Examples:

- Planning Agent
- Architecture Agent
- Implementation Agent
- Review Agent

---

### Advanced Memory Systems

Future versions may include:

- vector databases
- semantic knowledge graphs
- automated pattern extraction

---

### Workflow Variants

Different development methodologies may be supported.

Examples:

- test-driven workflows
- research workflows
- infrastructure automation

---

## Directory Structure

The project follows a modular directory structure aligned with the system architecture.

```
autonomous-engineer/
├─ cli/
│  └─ index.ts
│
├─ core/
│  ├─ workflow/
│  │  └─ workflow-engine.ts
│  │
│  ├─ memory/
│  │  └─ memory-manager.ts
│  │
│  ├─ llm/
│  │  └─ llm-provider.ts
│  │
│  └─ self-healing/
│     └─ self-healing-engine.ts
│
├─ engines/
│  ├─ spec/
│  │  └─ spec-engine.ts
│  │
│  ├─ implementation/
│  │  └─ implementation-engine.ts
│  │
│  └─ review/
│     └─ review-engine.ts
│
├─ adapters/
│  ├─ sdd/
│  │  ├─ cc-sdd-adapter.ts
│  │  ├─ openspec-adapter.ts
│  │  └─ speckit-adapter.ts
│  │
│  └─ llm/
│     ├─ claude-provider.ts
│     ├─ codex-provider.ts
│     └─ cursor-provider.ts
│
├─ infra/
│  ├─ git/
│  │  └─ git-controller.ts
│  │
│  └─ filesystem/
│     └─ file-manager.ts
│
├─ docs/
│  ├─ README.md
│  ├─ index.md
│  ├─ vision.md
│  ├─ system-overview.md
│  ├─ specs.md
│  │
│  ├─ architecture/
│  │  ├─ architecture.md
│  │  ├─ agent-loop-architecture.md
│  │  ├─ agent-safety-architecture.md
│  │  ├─ codebase-intelligence-architecture.md
│  │  ├─ context-engineering-architecture.md
│  │  ├─ task-planning-architecture.md
│  │  └─ tool-system-architecture.md
│  │
│  ├─ agent/
│  │  └─ dev-agent-v1.md
│  │
│  ├─ workflow/
│  │  └─ spec-driven-workflow.md
│  │
│  ├─ memory/
│  │  └─ memory-architecture.md
│  │
│  └─ development/
│     ├─ development-environment.md
│     └─ ai-agent-framework-policy.md
│
├─ rules/
│  ├─ coding_rules.md
│  ├─ review_rules.md
│  └─ implementation_patterns.md
│
├─ .memory/
│  ├─ project_rules.md
│  ├─ coding_patterns.md
│  └─ review_feedback.md
│
├─ package.json
├─ tsconfig.json
└─ README.md
```

Each directory corresponds to a logical component of the system.

### Structure Philosophy

The directory structure separates core system logic from external integrations.

- `core/` contains fundamental system components
- `engines/` contain domain-specific execution logic
- `adapters/` connect the system to external tools
- `infra/` handles infrastructure concerns
- `docs/` provides architectural knowledge for both developers and AI agents

This structure allows the system to evolve while keeping the core logic independent from external dependencies.

---

## Summary

The architecture of Autonomous Engineer focuses on:

- modular design
- strict boundaries
- provider abstraction
- workflow determinism
- AI orchestration
- persistent learning

This architecture allows the system to evolve from a **single AI development agent** into a **fully autonomous engineering platform** capable of managing complex software systems.
