# Situation Analysis: Orchestrator-TS Class Diagram

## 1. Relevant Directories in `orchestrator-ts/src/`

| Directory | Purpose |
|-----------|---------|
| `application/ports/` | Abstract interface contracts (20 port files) defining LLM, logging, memory, workflow, safety, and context engine ports |
| `application/services/` | Concrete service implementations organizing domain logic around agent loop, context, workflow, implementation loop, planning, tools, git, and safety |
| `domain/` | Pure business logic and domain models (no external dependencies): agent types, context planning, workflow definitions, safety guards, planning models, implementation-loop types |
| `infra/` | Concrete infrastructure implementations: LLM providers (Claude, mock), loggers, memory stores, git adapters, SDD adapters, event buses, tools (shell, filesystem, git, code-analysis) |
| `adapters/cli/` | Inbound delivery adapters for CLI commands (run, configure) |
| `main/` | Entry point and top-level dependency injection container |

## 2. Key Ports (Abstract Interfaces)

### Core Execution Ports
| Port | Location | Implementations |
|------|----------|-----------------|
| `LlmProviderPort` | `ports/llm.ts` | `ClaudeProvider`, `MockLlmProvider` |
| `ILogger` | `ports/logger.ts` | `ConsoleLogger`, `NdjsonFileLogger`, `AuditLogger`, `JsonLogWriter` |
| `MemoryPort` | `ports/memory.ts` | `FileMemoryStore` |
| `IAgentLoop` | `ports/agent-loop.ts` | `AgentLoopService` |
| `IContextEngine` | `ports/context.ts` | `ContextEngineService` |

### Event Bus & Workflow Ports
| Port | Location | Implementations |
|------|----------|-----------------|
| `IWorkflowEventBus` | `ports/workflow.ts` | `WorkflowEventBus` |
| `IWorkflowStateStore` | `ports/workflow.ts` | `WorkflowStateStore` |
| `IGitEventBus` | `ports/git-event-bus.ts` | `GitEventBus` |
| `IImplementationLoopEventBus` | `ports/implementation-loop.ts` | (service-level integration) |

### Safety & Approval Ports
| Port | Location | Implementations |
|------|----------|-----------------|
| `IApprovalGateway` | `ports/safety.ts` | `ApprovalGateway` |
| `IAuditLogger` | `ports/safety.ts` | `AuditLogger` |
| `ISandboxExecutor` | `ports/safety.ts` | `TempDirSandboxExecutor` |
| `IEmergencyStopHandler` | `ports/safety.ts` | (concrete implementation in safety module) |

### Application-Level Ports
| Port | Location | Implementations |
|------|----------|-----------------|
| `IImplementationLoop` | `ports/implementation-loop.ts` | `ImplementationLoopService` |
| `IReviewEngine` | `ports/implementation-loop.ts` | `LlmReviewEngineService` |
| `IQualityGate` | `ports/implementation-loop.ts` | `QualityGateRunner` |
| `SddFrameworkPort` | `ports/sdd.ts` | `CcSddAdapter`, `MockSddAdapter` |
| `FrameworkDefinitionPort` | `ports/framework.ts` | (framework loader) |

## 3. Domain Models (Core Types)

### Agent Domain (`domain/agent/types.ts`)
- **ActionPlan**: Output of PLAN step
- **ReflectionOutput**: Output of REFLECT step
- **TerminationCondition**: Union of {TASK_COMPLETED, MAX_ITERATIONS_REACHED, HUMAN_INTERVENTION_REQUIRED, ERROR_ENCOUNTERED, SAFETY_STOP}
- **AgentState**: Complete agent execution state with observations, errors, and loop history

### Workflow Domain (`domain/workflow/`)
- **WorkflowPhase**: String type for phase names
- **WorkflowState**: State machine {specName, currentPhase, completedPhases, status, failureDetail, timestamps}
- **PhaseDefinition**: Orchestration metadata {phase, type, content, requiredArtifacts, approvalGate, outputFile}
- **LoopPhaseDefinition**: Sub-phase for implementation loop iterations {phase, type, content}
- **FrameworkDefinition**: Complete workflow definition with all phases

### Planning Domain (`domain/planning/types.ts`)
- **Step**: Minimal work unit with {id, description, status, dependsOn, statusHistory}
- **Task**: Container with {id, title, status, steps}
- **TaskPlan**: Four-level hierarchy {id, goal, tasks, timestamps}
- **PlanReviewReason**: Union {large-plan, high-risk-operations}

### Context Domain (`domain/context/types.ts`)
- **LayerId**: Union of 7 layer types {systemInstructions, taskDescription, activeSpecification, codeContext, repositoryState, memoryRetrieval, toolResults}
- **StepType**: Union {Exploration, Modification, Validation}
- **IContextPlanner**: Pure decision logic that maps step context to retrieval plan
- **ILayerCompressor**: Compression strategies {spec_extraction, code_skeleton, memory_score_filter, truncation}
- **ITokenBudgetManager**: Per-layer token budgets with defaults
- **IContextCache**: In-memory cache with LRU eviction
- **IContextAccumulator**: Scope-aware entry accumulation (by phase + task)

### Implementation-Loop Domain (`domain/implementation-loop/types.ts`)
- **ReviewResult**: {outcome, checks, feedback, durationMs}
- **ReviewCheckResult**: {checkName, outcome, required, details}
- **SectionExecutionRecord**: Complete log of section execution with iterations
- **SectionIterationRecord**: Single implement-review-improve cycle
- **SectionEscalation**: Data passed to self-healing loop

### Safety Domain (`domain/safety/`)
- **SafetyConfig**: Immutable configuration {workspaceRoot, protectedFilePatterns, rateLimits, sandboxMethod, approvalTimeoutMs}
- **SafetySession**: Runtime state tracking {sessionId, startMs, emergencyStopRequested}
- **ApprovalRequest**: {riskClassification, description, expectedImpact, proposedAction}

## 4. Application Services (Business Logic Layer)

### Agent Service (`services/agent/`)
- **AgentLoopService** (implements `IAgentLoop`)
  - Orchestrates PLAN→ACT→OBSERVE→REFLECT→UPDATE_STATE loop
  - Integrates with LLM provider for PLAN/REFLECT steps
  - Accepts optional `IContextProvider` for PLAN-step context delegation
  - Emits optional agent loop events via `IAgentEventBus`

### Context Service (`services/context/`)
- **ContextEngineService** (implements `IContextEngine`)
  - 7-layer context assembly with token budgeting
  - Compression logic for oversized layers
  - Caching with invalidation tracking
  - Expansion support for mid-iteration growth

### Workflow Service (`services/workflow/`)
- **WorkflowEngine**: State machine orchestrator {stateStore, eventBus, phaseRunner, approvalGate}
- **PhaseRunner**: Executes individual phase steps {agent loop, SDD commands, human approval}

### Implementation Loop Service (`services/implementation-loop/`)
- **ImplementationLoopService** (implements `IImplementationLoop`)
  - Per-task implement-review-improve cycles
  - Quality gate checks + review engine evaluation
  - Loop-phase support (YAML-configured sub-phases)
  - Optional self-healing escalation
  - Structured logging via `IImplementationLoopLogger`
- **LlmReviewEngineService** (implements `IReviewEngine`)
- **QualityGateRunner**: Shell command execution via tool executor

### Planning Service (`services/planning/`)
- **TaskPlanningService** (implements `ITaskPlanner`)
  - Decomposes requirements into task/step hierarchy
  - LLM-driven plan generation with parse retry logic
  - Human review gate for large/high-risk plans
  - Plan validation and serialization

### Tool Service (`services/tools/`)
- **ToolExecutor**: Marshals agent tool invocations to infrastructure
  - Shell, filesystem, git, code-analysis tool implementations

## 5. Infrastructure Implementations

### LLM (`infra/llm/`)
- **ClaudeProvider**: Anthropic SDK wrapper with conversation history
- **MockLlmProvider**: Test double for --debug-flow; emits to `IDebugEventSink`

### Logger (`infra/logger/`)
- **ConsoleLogger**: Stdout/stderr with ANSI color codes
- **NdjsonFileLogger**: NDJSON format for structured logs
- **AuditLogger**: Compliance-focused audit trail
- Multiple specialized loggers for agent loop, self-healing loop, implementation loop

### Memory (`infra/memory/`)
- **FileMemoryStore** (implements `MemoryPort`)
  - File-backed persistent memory with `.memory/` directory structure
  - Atomic write semantics
  - Short-term ephemeral store via `InProcessShortTermStore`
  - Failure record tracking

### Event Bus (`infra/events/`)
- **WorkflowEventBus**: Node.js EventEmitter wrapping workflow events
- **GitEventBus**: Node.js EventEmitter wrapping git events

### Safety (`infra/safety/`)
- **ApprovalGateway** (implements `IApprovalGateway`)
  - Readline-based CLI approval with timeout
- **TempDirSandboxExecutor** (implements `ISandboxExecutor`)
  - Temp directory isolation using Bun.spawn
- **EmergencyStopHandler**: OS signal listeners (SIGINT, SIGTERM)

### SDD (`infra/sdd/`)
- **CcSddAdapter** (implements `SddFrameworkPort`)
  - Executes Claude Code slash commands
- **MockSddAdapter**: Test double
- **YamlWorkflowDefinitionLoader**: Loads framework definitions from YAML

### Git (`infra/git/`)
- **GitControllerAdapter**: Git operations (clone, commit, push)
- **GitHubPrAdapter**: PR creation and branch management

### Tools (`infra/tools/`)
- **ShellTool**: Command execution with sandbox enforcement
- **FilesystemTool**: File I/O (read, write, list)
- **GitTool**: Git operations accessible to agent
- **CodeAnalysisTool**: Codebase introspection
- **KnowledgeTool**: Memory/documentation queries

### Config (`infra/config/`)
- **ConfigLoader**: YAML/JSON configuration loading
- **ConfigWriter**: Configuration persistence
- **SddFrameworkChecker**: SDD framework detection

## 6. Inheritance & Implementation Relationships

```
ILlmProviderPort ← ClaudeProvider
                ← MockLlmProvider

ILogger ← ConsoleLogger
       ← NdjsonFileLogger
       ← AuditLogger
       ← JsonLogWriter

IWorkflowEventBus ← WorkflowEventBus
IGitEventBus      ← GitEventBus

IApprovalGateway      ← ApprovalGateway
ISandboxExecutor      ← TempDirSandboxExecutor

MemoryPort ← FileMemoryStore

IAgentLoop              ← AgentLoopService
IContextEngine          ← ContextEngineService
IImplementationLoop     ← ImplementationLoopService
IReviewEngine           ← LlmReviewEngineService
SddFrameworkPort        ← CcSddAdapter
                        ← MockSddAdapter
FrameworkDefinitionPort ← YamlWorkflowDefinitionLoader
```

### Composition Relationships (Services using Ports)

**WorkflowEngine** depends on:
- `IWorkflowStateStore`, `IWorkflowEventBus`, `PhaseRunner`, `ApprovalGate`, `FrameworkDefinition`

**AgentLoopService** depends on:
- `LlmProviderPort`, `IToolExecutor`, `IContextProvider?`, `IAgentEventBus?`, `ILogger?`

**ImplementationLoopService** depends on:
- `IAgentLoop`, `IReviewEngine`, `IQualityGate`, `IPlanStore`, `SddFrameworkPort?`, `LlmProviderPort?`, `ISelfHealingLoop?`, `IImplementationLoopLogger?`, `IImplementationLoopEventBus?`, `IContextEngine?`, `IAgentEventBus?`

**ContextEngineService** depends on:
- `IContextCache`, `IContextAccumulator`, `IContextPlanner`, `ILayerCompressor`, `ITokenBudgetManager`, `MemoryPort`, `IToolExecutor`

**TaskPlanningService** depends on:
- `LlmProviderPort`, `IAgentLoop`, `IHumanReviewGateway`, `ITaskPlanStore`

## 7. Statistics

- **~105 TypeScript files** across 6 main layers
- **20 port definitions** spanning execution, logging, workflow, safety, context, planning, implementation
- **12 domain modules** covering agent, workflow, planning, context, safety, tools, implementation-loop
- **10 service modules** with ~25 service classes total
- **14 infra modules** with 25+ concrete implementations
