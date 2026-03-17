import type { AesConfig } from "@/application/ports/config";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { IImplementationLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { IJsonLogWriter } from "@/application/ports/logging";
import { DebugAgentEventBus } from "@/application/services/agent/debug-agent-event-bus";
import { ToolContextLogger } from "@/application/services/tools/tool-context-logger";
import { DebugApprovalGate } from "@/application/services/workflow/debug-approval-gate";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { createImplementationLoopService } from "@/di/create-implementation-loop-service";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { ClaudeProvider } from "@/infra/llm/claude-provider";
import { MockLlmProvider } from "@/infra/llm/mock-llm-provider";
import { ConsoleLogger } from "@/infra/logger/console-logger";
import { DebugLogWriter } from "@/infra/logger/debug-log-writer";
import { JsonLogWriter } from "@/infra/logger/json-log-writer";
import { NdjsonFileLogger } from "@/infra/logger/ndjson-file-logger";
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
  readonly logger: ILogger;
}

export interface RunOptions {
  readonly debug: boolean;
  readonly debugLog?: string;
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
  private _logger?: ILogger;
  private _toolContextLogger?: ToolContextLogger;

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
      this._debugWriter = this.options.debug
        ? new DebugLogWriter()
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

  private get logger(): ILogger {
    if (!this._logger) {
      const minLevel = this.options.debug ? "debug" : this.config.logLevel;
      this._logger = this.options.debugLog !== undefined
        ? new NdjsonFileLogger(this.options.debugLog, minLevel)
        : new ConsoleLogger(minLevel);
    }
    return this._logger;
  }

  private get toolContextLogger(): ToolContextLogger {
    if (!this._toolContextLogger) {
      this._toolContextLogger = new ToolContextLogger(this.logger);
    }
    return this._toolContextLogger;
  }

  private get implementationLoop(): IImplementationLoop {
    if (!this._implementationLoop) {
      this._implementationLoop = createImplementationLoopService({
        llm: this.newLlmProvider(),
        workspaceRoot: process.cwd(),
        noOpGit: this.options.debug,
        logger: this.toolContextLogger,
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
        sdd: this.options.debug ? new MockSddAdapter(this.debugWriter ?? undefined) : new CcSddAdapter(),
        memory: this.memory,
        implementationLoop: this.implementationLoop,
        createLlmProvider: (_cfg, override) => this.newLlmProvider(override),
        logger: this.logger,
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
    if (this.options.debug && writer !== null) {
      return new MockLlmProvider({ sink: writer, workflowEventBus: this.eventBus, logger: this.logger });
    }
    const provider = providerOverride ?? this.options.providerOverride ?? this.config.llm.provider;
    switch (provider) {
      case "claude":
        return new ClaudeProvider(
          { apiKey: this.config.llm.apiKey, modelName: this.config.llm.modelName },
          undefined,
          this.logger,
        );
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
    // Resolve logger first — required for all subsequent DI log entries.
    const logger = this.logger;
    logger.debug("DI resolved", { dependency: "logger", impl: "ConsoleLogger" });

    // Resolve and log each infrastructure dependency.
    const eventBus = this.eventBus;
    logger.debug("DI resolved", { dependency: "eventBus", impl: "WorkflowEventBus" });

    const logWriter = this.logWriter;
    logger.debug("DI resolved", {
      dependency: "logWriter",
      impl: logWriter !== null ? "JsonLogWriter" : "null",
    });

    const debugWriter = this.debugWriter;
    logger.debug("DI resolved", {
      dependency: "debugWriter",
      impl: debugWriter !== null ? "DebugLogWriter" : "null",
    });

    logger.debug("DI resolved", { dependency: "toolContextLogger", impl: "ToolContextLogger" });

    const _memory = this.memory;
    logger.debug("DI resolved", { dependency: "memory", impl: "FileMemoryStore" });

    // Announce mock substitutions before the use case is constructed so that
    // operators see the active stub list at the top of the debug output.
    if (this.options.debug) {
      logger.info("Mock substitution active", {
        dependency: "llmProvider",
        impl: "MockLlmProvider",
        reason: "debug mode",
      });
      logger.info("Mock substitution active", {
        dependency: "sdd",
        impl: "MockSddAdapter",
        reason: "debug mode",
      });
    }

    // Resolve the use case last — its construction pulls in the remaining deps.
    const useCase = this.useCase;
    logger.debug("DI resolved", { dependency: "useCase", impl: "RunSpecUseCase" });

    // Wire side-effects (event-bus → log writer).
    if (logWriter !== null) {
      eventBus.on((event) => {
        logWriter.write(event).catch((err) => {
          logger.warn("Failed to write to log file", { error: getErrorMessage(err) });
        });
      });
    }

    return { useCase, eventBus, logWriter, debugWriter, logger };
  }
}
