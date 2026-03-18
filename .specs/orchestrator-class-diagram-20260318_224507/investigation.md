# Investigation: Orchestrator-TS Class Diagram — Exact Type Signatures

## 1. Application Ports (Abstract Interfaces)

### 1.1 Core Execution Ports

**LlmProviderPort** (`ports/llm.ts`)
- Methods:
  - `complete(prompt: string, options?: LlmCompleteOptions): Promise<LlmResult>`
  - `clearContext(): void`
- Implementations: `ClaudeProvider`, `MockLlmProvider`

**ILogger** (`ports/logger.ts`)
- Methods:
  - `debug(message: string, context?: LogContext): void`
  - `info(message: string, context?: LogContext): void`
  - `warn(message: string, context?: LogContext): void`
  - `error(message: string, context?: LogContext): void`
- Implementations: `ConsoleLogger`, `NdjsonFileLogger`, `AuditLogger`, `JsonLogWriter`

**MemoryPort** (`ports/memory.ts`)
- Properties: `shortTerm: ShortTermMemoryPort`
- Methods:
  - `query(query: MemoryQuery): Promise<MemoryQueryResult>`
  - `append(target: MemoryTarget, entry: MemoryEntry, trigger: MemoryWriteTrigger): Promise<MemoryWriteResult>`
  - `update(target: MemoryTarget, entryTitle: string, entry: MemoryEntry): Promise<MemoryWriteResult>`
  - `writeFailure(record: FailureRecord): Promise<MemoryWriteResult>`
  - `getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]>`
- Implementations: `FileMemoryStore`

**IAgentLoop** (`ports/agent-loop.ts`)
- Methods:
  - `run(task: string, options?: Partial<AgentLoopOptions>): Promise<AgentLoopResult>`
  - `stop(): void`
  - `getState(): Readonly<AgentState> | null`
- Implementations: `AgentLoopService`

**IContextProvider** (`ports/agent-loop.ts`)
- Methods:
  - `buildContext(state: AgentState, toolSchemas: ReadonlyArray<ToolListEntry>): Promise<string>`

**IAgentEventBus** (`ports/agent-loop.ts`)
- Methods:
  - `emit(event: AgentLoopEvent): void`
  - `on(handler: (event: AgentLoopEvent) => void): void`
  - `off(handler: (event: AgentLoopEvent) => void): void`

### 1.2 Context Engine Ports

**IContextEngine** (`ports/context.ts`)
- Methods:
  - `buildContext(request: ContextBuildRequest): Promise<ContextAssemblyResult>`
  - `expandContext(request: ExpansionRequest): Promise<ExpansionResult>`
  - `resetPhase(phaseId: string): void`
  - `resetTask(taskId: string): void`
- Implementations: `ContextEngineService`

**IContextCache** (`ports/context.ts`)
- Methods: `get()`, `set()`, `invalidate()`, `stats()`, `clear()`

**IContextAccumulator** (`ports/context.ts`)
- Methods: `accumulate()`, `getEntries()`, `recordExpansion()`, `getExpansionEvents()`, `resetPhase()`, `resetTask()`

**IContextPlanner** (`domain/context/types.ts`)
- Methods:
  - `plan(stepType: StepType, taskDescription: string, previousToolResults: ReadonlyArray<ToolResultEntry>): PlannerDecision`

**ILayerCompressor** (`domain/context/types.ts`)
- Methods:
  - `compress(layerId: LayerId, content: string, budget: number, tokenCounter: (text: string) => number): CompressionResult`

**ITokenBudgetManager** (`domain/context/types.ts`)
- Methods:
  - `countTokens(text: string): number`
  - `allocate(config: TokenBudgetConfig): LayerBudgetMap`
  - `checkBudget(content: string, budget: number): { tokensUsed: number; overBy: number }`
  - `checkTotal(layerTokenCounts: ReadonlyArray<...>, totalBudget: number): number`

### 1.3 Workflow Ports

**IWorkflowStateStore** (`ports/workflow.ts`)
- Methods: `persist()`, `restore()`, `init()`
- Implementations: `WorkflowStateStore`

**IWorkflowEventBus** (`ports/workflow.ts`)
- Methods: `emit()`, `on()`, `off()`
- Implementations: `WorkflowEventBus`

### 1.4 Safety Ports

**IApprovalGateway** (`ports/safety.ts`)
- Methods: `requestApproval(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalDecision>`
- Implementations: `ApprovalGateway`

**IAuditLogger** (`ports/safety.ts`)
- Methods: `write(entry: AuditEntry): Promise<void>`, `flush(): Promise<void>`
- Implementations: `AuditLogger`

**ISandboxExecutor** (`ports/safety.ts`)
- Methods: `execute(request: SandboxExecutionRequest, timeoutMs: number): Promise<SandboxExecutionResult>`
- Implementations: `TempDirSandboxExecutor`

**IEmergencyStopHandler** (`ports/safety.ts`)
- Methods: `register()`, `trigger()`, `deregister()`
- Implementations: `EmergencyStopHandler`

### 1.5 Implementation Loop Ports

**IImplementationLoop** (`ports/implementation-loop.ts`)
- Methods:
  - `run(planId: string, options?: Partial<ImplementationLoopOptions>): Promise<ImplementationLoopResult>`
  - `resume(planId: string, options?: Partial<ImplementationLoopOptions>): Promise<ImplementationLoopResult>`
  - `stop(): void`
- Implementations: `ImplementationLoopService`

**IReviewEngine** (`ports/implementation-loop.ts`)
- Methods: `review(result: AgentLoopResult, section: Task, config: QualityGateConfig): Promise<ReviewResult>`
- Implementations: `LlmReviewEngineService`

**IQualityGate** (`ports/implementation-loop.ts`)
- Methods: `run(config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>>`
- Implementations: `QualityGateRunner`

**IPlanStore** (`ports/implementation-loop.ts`)
- Methods: `loadPlan()`, `updateSectionStatus()`

**IImplementationLoopLogger** (`ports/implementation-loop.ts`)
- Methods: `logIteration()`, `logSectionComplete()`, `logHaltSummary()`

**IImplementationLoopEventBus** (`ports/implementation-loop.ts`)
- Methods: `emit(event: ImplementationLoopEvent): void`

**ISelfHealingLoop** (`ports/implementation-loop.ts`)
- Methods: `escalate(escalation: SectionEscalation): Promise<SelfHealingResult>`

### 1.6 SDD & Framework Ports

**SddFrameworkPort** (`ports/sdd.ts`)
- Methods: `executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult>`
- Implementations: `CcSddAdapter`, `MockSddAdapter`

**FrameworkDefinitionPort** (`ports/framework.ts`)
- Methods: `load(frameworkId: string): Promise<FrameworkDefinition>`
- Implementations: `YamlWorkflowDefinitionLoader`

### 1.7 Planning Ports

**ITaskPlanner** (`ports/task-planning.ts`)
- Methods: `run()`, `resume()`, `listResumable()`, `stop()`
- Implementations: `TaskPlanningService`

**ITaskPlanStore**, **IPlanContextBuilder**, **IHumanReviewGateway**, **IPlanEventBus** — sub-ports for planning

### 1.8 Git & Tool Ports

**IGitController** (`ports/git-controller.ts`)
- Methods: `listBranches()`, `detectChanges()`, `createAndCheckoutBranch()`, `stageAndCommit()`, `push()`
- Implementations: `GitControllerAdapter`

**IToolExecutor** (`ports/tool-executor.ts`)
- Methods: `invoke(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult<unknown>>`
- Implementations: `ToolExecutor`

## 2. Domain Types (Core Business Models)

### 2.1 Agent Domain

**AgentState** — {task, plan, completedSteps, currentStep, iterationCount, observations, recoveryAttempts, startedAt}
**ActionPlan** — {category, toolName, toolInput, rationale}
**ReflectionOutput** — {assessment, learnings, planAdjustment, taskComplete?, summary}
**Observation** — {toolName, toolInput, rawOutput, error?, success, recordedAt, reflection?}
**TerminationCondition** — union: "TASK_COMPLETED" | "MAX_ITERATIONS_REACHED" | "HUMAN_INTERVENTION_REQUIRED" | "SAFETY_STOP" | "RECOVERY_EXHAUSTED"

### 2.2 Workflow Domain

**FrameworkDefinition** — {id: string, phases: readonly PhaseDefinition[]}
**PhaseDefinition** — {phase, type, content, requiredArtifacts, approvalGate?, approvalArtifact?, outputFile?, loopPhases?}
**LoopPhaseDefinition** — {phase, type: LoopPhaseExecutionType, content}
**WorkflowState** — {specName, currentPhase, completedPhases, status, failureDetail?, startedAt, updatedAt}

### 2.3 Planning Domain

**TaskPlan** — {id, goal, tasks: readonly Task[], createdAt, updatedAt}
**Task** — {id, title, status, steps: readonly Step[]}
**Step** — {id, description, status, dependsOn, statusHistory}

### 2.4 Implementation-Loop Domain

**ReviewResult** — {outcome, checks, feedback, durationMs}
**ReviewCheckResult** — {checkName, outcome, required, details}
**SectionExecutionRecord** — {sectionId, planId, title, status, retryCount, iterations, startedAt, completedAt?, commitSha?, escalationSummary?}
**SectionIterationRecord** — {iterationNumber, reviewResult, improvePrompt?, durationMs, timestamp}
**SectionEscalation** — {sectionId, planId, retryHistory, reviewFeedback, agentObservations}

### 2.5 Safety Domain

**SafetyConfig** — immutable config with workspace, patterns, rate limits, timeout
**SafetySession** — mutable per-session state: {sessionId, startedAtMs, iterationCount, paused, emergencyStopRequested, ...}

### 2.6 Context Domain

**LayerId** — union of 7 layer identifiers
**StepType** — "Exploration" | "Modification" | "Validation"
**PlannerDecision** — {layersToRetrieve, codeContextQuery?, memoryQuery?, specSections?, rationale}

## 3. Service Constructor Dependencies (for Composition)

### AgentLoopService implements IAgentLoop
```
+ llmProvider: LlmProviderPort
+ toolExecutor: IToolExecutor
+ toolRegistry: IToolRegistry
? contextProvider: IContextProvider
? eventBus: IAgentEventBus
? logger: AgentLoopLogger
```

### ContextEngineService implements IContextEngine
```
+ cache: IContextCache
+ accumulator: IContextAccumulator
+ planner: IContextPlanner
+ compressor: ILayerCompressor
+ budgetManager: ITokenBudgetManager
+ memory: MemoryPort
+ toolExecutor: IToolExecutor
+ options: ContextEngineServiceOptions
```

### WorkflowEngine (no interface)
```
+ stateStore: IWorkflowStateStore
+ eventBus: IWorkflowEventBus
+ phaseRunner: PhaseRunner
+ approvalGate: ApprovalGate
+ frameworkDefinition: FrameworkDefinition
```

### PhaseRunner (no interface)
```
+ sdd: SddFrameworkPort
+ llm: LlmProviderPort
+ frameworkDefinition: FrameworkDefinition
? implementationLoop: IImplementationLoop
? implementationLoopOptions: Partial<ImplementationLoopOptions>
```

### ImplementationLoopService implements IImplementationLoop
```
+ agentLoop: IAgentLoop
+ reviewEngine: IReviewEngine
+ qualityGate: IQualityGate
+ planStore: IPlanStore
+ gitController: IGitController
? sdd: SddFrameworkPort
? llm: LlmProviderPort
? selfHealingLoop: ISelfHealingLoop
? eventBus: IImplementationLoopEventBus
? logger: IImplementationLoopLogger
? contextEngine: IContextEngine
? agentEventBus: IAgentEventBus
```

### LlmReviewEngineService implements IReviewEngine
```
+ llm: LlmProviderPort
```

### QualityGateRunner implements IQualityGate
```
+ toolExecutor: IToolExecutor
+ context: ToolContext
```

### TaskPlanningService implements ITaskPlanner
```
+ llm: LlmProviderPort
+ agentLoop: IAgentLoop
+ planStore: ITaskPlanStore
+ contextBuilder: IPlanContextBuilder
+ reviewGateway: IHumanReviewGateway
? eventBus: IPlanEventBus
? logger: AgentLoopLogger
```

### ToolExecutor implements IToolExecutor
```
+ registry: IToolRegistry
+ permissions: IPermissionSystem
+ config: ToolExecutorConfig
```

## 4. Infrastructure Class → Interface Mapping

| Class | Implements |
|-------|-----------|
| `ClaudeProvider` | `LlmProviderPort` |
| `MockLlmProvider` | `LlmProviderPort` |
| `ConsoleLogger` | `ILogger` |
| `NdjsonFileLogger` | `ILogger` |
| `AuditLogger` | `IAuditLogger` |
| `FileMemoryStore` | `MemoryPort` |
| `WorkflowEventBus` | `IWorkflowEventBus` |
| `WorkflowStateStore` | `IWorkflowStateStore` |
| `ApprovalGateway` | `IApprovalGateway` |
| `TempDirSandboxExecutor` | `ISandboxExecutor` |
| `EmergencyStopHandler` | `IEmergencyStopHandler` |
| `CcSddAdapter` | `SddFrameworkPort` |
| `MockSddAdapter` | `SddFrameworkPort` |
| `YamlWorkflowDefinitionLoader` | `FrameworkDefinitionPort` |
| `GitControllerAdapter` | `IGitController` |
