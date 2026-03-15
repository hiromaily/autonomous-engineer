# System Overview

## Introduction

Autonomous Engineer is a system designed to automate the software development lifecycle using AI agents.

The system orchestrates AI models to perform engineering tasks such as:

- specification generation
- system design
- task planning
- feature implementation
- code review
- iterative improvement
- pull request creation

Rather than acting as a simple coding assistant, the system operates as a **workflow orchestrator** that coordinates structured development processes.

The system is built around **Spec-Driven Development (SDD)** and a **state-driven workflow engine** that manages each development phase.

---

## High-Level Architecture

The system consists of several major subsystems.

```
            ┌─────────────────────────┐
            │        CLI Layer        │
            │   (User Interaction)    │
            └─────────────┬───────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │     Workflow Engine     │
            │   (State Orchestration) │
            └─────────────┬───────────┘
                          │
    ┌─────────────────────┼─────────────────────┐
    ▼                     ▼                     ▼

Spec Engine        Implementation Engine      Review Engine
(SDD Adapter)        (Task Execution)         (Quality Loop)

    │                     │                     │
    └──────────────┬──────┴──────┬──────────────┘
                   ▼             ▼

             LLM Provider     Git Controller
                Layer         (Repository Ops)

                        │
                        ▼

                    Memory System
```

Each subsystem has a clearly defined responsibility and communicates through well-defined interfaces.

---

## Core Components

## 1. CLI Layer

The CLI layer provides the entry point for running the system.

The command is named `aes`, which stands for **Autonomous Engineer System**.

Example command:

```sh
aes run <spec-name>
```

The CLI triggers the workflow engine to execute a full spec-driven development pipeline.

Responsibilities:

- user interaction
- configuration loading
- execution triggers
- progress reporting

---

## 2. Workflow Engine

The Workflow Engine is the central orchestrator of the system.

It manages the **development lifecycle as a state machine**.

Each phase corresponds to a specific development activity.

Typical workflow:

```
SPEC_INIT
    ↓
VALIDATE_PREREQUISITES
    ↓
REQUIREMENTS
    ↓
VALIDATE_REQUIREMENTS (llm)
    ↓
VALIDATE_EXISTING_INFORMATION (llm)
    ↓
VALIDATE_GAP (optional)
    ↓
DESIGN
    ↓
VALIDATE_DESIGN (optional)
    ↓
VALIDATE_EXISTING_INFORMATION (llm)
    ↓
TASK_GENERATION
    ↓
VALIDATE_TASK
    ↓
IMPLEMENTATION
    ↓
PULL_REQUEST
```

Phases marked `(llm)` are LLM-assisted validation steps that run automatically within the orchestrator, without requiring human approval gates.

The workflow engine is responsible for:

- coordinating system phases
- invoking appropriate engines
- managing transitions
- controlling context boundaries

This ensures development progresses in a structured and deterministic way.

---

## 3. Spec Engine

The Spec Engine handles integration with Spec-Driven Development frameworks.

The system is designed to support multiple SDD implementations through adapters.

Supported frameworks may include:

- cc-sdd
- OpenSpec
- SpecKit

Example abstraction:

```
SpecEngine

├── CCSddAdapter
├── OpenSpecAdapter
└── SpecKitAdapter
```

Responsibilities:

- initializing specs
- validating prerequisites
- generating requirements
- validating requirements
- creating design documents
- validating designs
- generating implementation tasks
- validating tasks

This abstraction allows the system to support different specification workflows.

---

## 4. Implementation Engine

The Implementation Engine executes tasks generated during the spec process.

Tasks are typically divided into **sections** or **subtasks**.

Each task section follows a structured loop:

```
Implement
↓
Review
↓
Improve
↓
Commit
```

Responsibilities:

- executing task sections
- invoking AI for code generation
- coordinating review cycles
- managing commits

This loop continues until the task section reaches an acceptable quality level.

---

## 5. Review Engine

The Review Engine ensures quality and correctness during development.

It performs iterative evaluation of generated outputs.

Review activities include:

- design validation
- code review
- requirement alignment checks
- improvement suggestions

The review engine may run multiple iterations until quality thresholds are satisfied.

Example loop:

```
Generate Output
↓
Review
↓
Identify Issues
↓
Improve
↓
Repeat
```

---

## 6. LLM Provider Layer

The LLM Provider layer abstracts access to AI models.

The system should support multiple providers through a unified interface.

Examples include:

```
LLMProvider

├── ClaudeProvider
├── CodexProvider
├── CursorProvider
└── CopilotProvider
```

Responsibilities:

- prompt execution
- response retrieval
- context management
- provider-specific handling

This abstraction prevents the system from becoming dependent on a single AI provider.

---

## 7. Git Controller

The Git Controller manages repository operations.

Responsibilities include:

- branch creation
- commits
- pull request generation
- repository state inspection

Example actions performed automatically by the system:

```
create branch
implement tasks
commit changes
push branch
create pull request
```

This enables end-to-end development automation.

---

## 8. Memory System

Persistent memory is a critical component of the system.

The memory system stores knowledge generated during development.

Memory is divided into several layers.

### Short-Term Memory

Temporary context used during a single workflow execution.

Examples:

- current spec context
- task execution history
- current design artifacts

---

### Project Memory

Knowledge specific to a repository.

Examples:

- coding conventions
- architecture decisions
- recurring implementation patterns
- review feedback

---

### Knowledge Memory

Reusable patterns extracted from previous development activities.

Examples:

- implementation strategies
- debugging patterns
- rule improvements

---

## 9. Self-Healing Mechanism

When the AI fails to solve a problem efficiently, the system performs automated analysis.

The process typically includes:

```
Execution Failure
↓
Root Cause Analysis
↓
Knowledge Gap Detection
↓
Rule Update
```

Outputs may include updates to:

```
rules/
coding_rules.md
review_rules.md
implementation_patterns.md
```

This allows the system to improve over time.

---

## 10. Context Management

LLM context must be carefully managed to avoid:

- token overuse
- context pollution
- degraded reasoning

The system applies several strategies.

### Phase Isolation

Context is reset when the workflow transitions to a new phase.

### Task Isolation

Each task section executes with a minimal context window.

### Context Pruning

Only relevant artifacts are included in prompts.

These strategies improve reasoning quality and reduce token consumption.

---

## Extensibility

The architecture is designed to be modular and extensible.

Major extension points include:

### SDD Frameworks

Different spec systems can be integrated via adapters.

### AI Model Providers

New LLM providers can be added without changing the core workflow.

### Workflow Variants

Alternative workflows may be implemented for different project types.

### Memory Backends

Memory storage systems can evolve as the project grows.

---

## Execution Flow

A typical execution flow may look like the following:

```
User runs command
↓
CLI initializes workflow
↓
Workflow engine starts spec lifecycle
↓
Spec engine generates artifacts
↓
Tasks are generated
↓
Implementation engine executes tasks
↓
Review engine validates outputs
↓
Git controller commits changes
↓
Pull request is created
```

The entire process can run with minimal human intervention.

---

## Future Evolution

The current architecture is designed to support future multi-agent systems.

Future versions may introduce specialized agents such as:

- Planning Agent
- Specification Agent
- Implementation Agent
- Review Agent
- Architecture Agent

These agents will collaborate to form a fully autonomous engineering team.

The current system serves as the foundation for this evolution.

---

## Further Reading

Detailed architecture documentation for each subsystem:

- [Architecture Overview](architecture/architecture.md) — layered architecture, principles, directory structure
- [Agent Loop](architecture/agent-loop-architecture.md) — PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle
- [Tool System](architecture/tool-system-architecture.md) — tool interface, registry, executor, categories
- [Context Engineering](architecture/context-engineering-architecture.md) — context layers, planner, token budget
- [Task Planning](architecture/task-planning-architecture.md) — goal→task→steps hierarchy, plan lifecycle
- [Agent Safety](architecture/agent-safety-architecture.md) — permissions, workspace isolation, guardrails
- [Codebase Intelligence](architecture/codebase-intelligence-architecture.md) — symbol index, dependency graph, semantic search
- [Memory Architecture](memory/memory-architecture.md) — short-term, project, and knowledge memory layers
- [Spec-Driven Workflow](workflow/spec-driven-workflow.md) — the full SDD phase workflow
- [Spec Plan](agent/dev-agent-v1-specs.md) — breakdown of v1 implementation into 10 independent specs
