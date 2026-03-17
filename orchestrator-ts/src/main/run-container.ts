import { JsonLogWriter } from "@/adapters/cli/json-log-writer";
import type { AesConfig } from "@/application/ports/config";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { IImplementationLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IJsonLogWriter } from "@/application/ports/logging";
import { DebugAgentEventBus } from "@/application/services/agent/debug-agent-event-bus";
import { DebugApprovalGate } from "@/application/services/workflow/debug-approval-gate";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { createImplementationLoopService } from "@/infra/implementation-loop/create-implementation-loop-service";
import { ClaudeProvider } from "@/infra/llm/claude-provider";
import { MockLlmProvider } from "@/infra/llm/mock-llm-provider";
import { DebugLogWriter } from "@/infra/logger/debug-log-writer";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { CcSddAdapter } from "@/infra/sdd/cc-sdd-adapter";
import { MockSddAdapter } from "@/infra/sdd/mock-sdd-adapter";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import { getErrorMessage } from "@/infra/utils/errors";

export interface RunDependencies {
  readonly useCase: RunSpecUseCase;
  readonly eventBus: WorkflowEventBus;
  readonly logWriter: IJsonLogWriter | null;
  readonly debugWriter: IDebugEventSink | null;
}

export interface RunOptions {
  readonly debugFlow: boolean;
  readonly debugFlowLog?: string;
  readonly logJsonPath?: string;
  readonly providerOverride?: string;
}

/**
 * DI container for the `run` command.
 *
 * Constructor is pure — it only stores config and options.
 * All dependencies are lazily instantiated and cached on first access.
 * Call `build()` once to wire side-effects (event listeners) and get the
 * fully assembled RunDependencies.
 */
export class RunContainer {
  constructor(
    private readonly config: AesConfig,
    private readonly options: RunOptions,
  ) {}

  // --------------------------------------------------------------------------
  // Cached instance fields
  // --------------------------------------------------------------------------

  private _eventBus?: WorkflowEventBus;
  private _logWriter?: IJsonLogWriter | null;
  private _debugWriter?: IDebugEventSink | null;
  private _debugApprovalGate?: DebugApprovalGate | null;
  private _debugAgentEventBus?: DebugAgentEventBus | null;
  private _implementationLoop?: IImplementationLoop;
  private _memory?: FileMemoryStore;
  private _useCase?: RunSpecUseCase;

  // --------------------------------------------------------------------------
  // Private lazy getters
  // --------------------------------------------------------------------------

  private get eventBus(): WorkflowEventBus {
    if (!this._eventBus) {
      this._eventBus = new WorkflowEventBus();
    }
    return this._eventBus;
  }

  private get logWriter(): IJsonLogWriter | null {
    if (this._logWriter === undefined) {
      this._logWriter = this.options.logJsonPath !== undefined
        ? new JsonLogWriter(this.options.logJsonPath)
        : null;
    }
    return this._logWriter;
  }

  private get debugWriter(): IDebugEventSink | null {
    if (this._debugWriter === undefined) {
      this._debugWriter = this.options.debugFlow
        ? new DebugLogWriter(this.options.debugFlowLog)
        : null;
    }
    return this._debugWriter;
  }

  private get debugApprovalGate(): DebugApprovalGate | null {
    if (this._debugApprovalGate === undefined) {
      const writer = this.debugWriter;
      this._debugApprovalGate = writer !== null ? new DebugApprovalGate(writer) : null;
    }
    return this._debugApprovalGate;
  }

  private get debugAgentEventBus(): DebugAgentEventBus | null {
    if (this._debugAgentEventBus === undefined) {
      const writer = this.debugWriter;
      this._debugAgentEventBus = writer !== null
        ? new DebugAgentEventBus({ sink: writer, workflowEventBus: this.eventBus })
        : null;
    }
    return this._debugAgentEventBus;
  }

  private get implementationLoop(): IImplementationLoop {
    if (!this._implementationLoop) {
      this._implementationLoop = createImplementationLoopService({
        llm: this.newLlmProvider(),
        workspaceRoot: process.cwd(),
        noOpGit: this.options.debugFlow,
      });
    }
    return this._implementationLoop;
  }

  private get memory(): FileMemoryStore {
    if (!this._memory) {
      this._memory = new FileMemoryStore({ baseDir: process.cwd() });
    }
    return this._memory;
  }

  private get useCase(): RunSpecUseCase {
    if (!this._useCase) {
      const debugApprovalGate = this.debugApprovalGate;
      const debugAgentEventBus = this.debugAgentEventBus;
      this._useCase = new RunSpecUseCase({
        stateStore: new WorkflowStateStore(),
        eventBus: this.eventBus,
        sdd: this.options.debugFlow ? new MockSddAdapter(this.debugWriter ?? undefined) : new CcSddAdapter(),
        memory: this.memory,
        implementationLoop: this.implementationLoop,
        createLlmProvider: (_cfg, override) => this.newLlmProvider(override),
        ...(debugApprovalGate !== null ? { approvalGate: debugApprovalGate } : {}),
        ...(debugAgentEventBus !== null ? { implementationLoopOptions: { agentEventBus: debugAgentEventBus } } : {}),
      });
    }
    return this._useCase;
  }

  // --------------------------------------------------------------------------
  // LLM provider factory — not cached; creates a new instance per call so that
  // providerOverride can differ between the implementation-loop LLM and the
  // per-run LLM requested by RunSpecUseCase.
  // --------------------------------------------------------------------------

  private newLlmProvider(providerOverride?: string): LlmProviderPort {
    const writer = this.debugWriter;
    if (this.options.debugFlow && writer !== null) {
      return new MockLlmProvider({ sink: writer, workflowEventBus: this.eventBus });
    }
    const provider = providerOverride ?? this.options.providerOverride ?? this.config.llm.provider;
    switch (provider) {
      case "claude":
        return new ClaudeProvider({ apiKey: this.config.llm.apiKey, modelName: this.config.llm.modelName });
      default:
        throw new Error(`Unsupported LLM provider: '${provider}'`);
    }
  }

  // --------------------------------------------------------------------------
  // Public assembly method
  // --------------------------------------------------------------------------

  /**
   * Wire side-effects (event-bus listeners) and return the assembled
   * RunDependencies. Should be called exactly once per container instance.
   */
  build(): RunDependencies {
    const logWriter = this.logWriter;
    if (logWriter !== null) {
      this.eventBus.on((event) => {
        logWriter.write(event).catch((err) => {
          process.stderr.write(`Warning: failed to write to log file: ${getErrorMessage(err)}\n`);
        });
      });
    }

    return {
      useCase: this.useCase,
      eventBus: this.eventBus,
      logWriter: this.logWriter,
      debugWriter: this.debugWriter,
    };
  }
}
