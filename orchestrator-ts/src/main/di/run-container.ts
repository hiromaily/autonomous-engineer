import type { AesConfig } from "@/application/ports/config";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { FrameworkDefinitionPort } from "@/application/ports/framework";
import type { IGitController } from "@/application/ports/git-controller";
import type { IImplementationLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { IJsonLogWriter } from "@/application/ports/logging";
import { AgentLoopService } from "@/application/services/agent/agent-loop-service";
import { DebugAgentEventBus } from "@/application/services/agent/debug-agent-event-bus";
import { ImplementationLoopService } from "@/application/services/implementation-loop/implementation-loop-service";
import { LlmReviewEngineService } from "@/application/services/implementation-loop/llm-review-engine";
import { QualityGateRunner } from "@/application/services/implementation-loop/quality-gate-runner";
import { ToolExecutor } from "@/application/services/tools/executor";
import { ToolContextLogger } from "@/application/services/tools/tool-context-logger";
import { DebugApprovalGate } from "@/application/services/workflow/debug-approval-gate";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { GitValidator } from "@/domain/git/git-validator";
import { PermissionSystem } from "@/domain/tools/permissions";
import { ToolRegistry } from "@/domain/tools/registry";
import type { ToolContext } from "@/domain/tools/types";
import type { FrameworkDefinition } from "@/domain/workflow/framework";
import { TypeScriptFrameworkDefinitionLoader } from "@/infra/config/typescript-framework-definition-loader";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { GitControllerAdapter } from "@/infra/git/git-controller-adapter";
import { ClaudeProvider } from "@/infra/llm/claude-provider";
import { MockLlmProvider } from "@/infra/llm/mock-llm-provider";
import { ConsoleLogger } from "@/infra/logger/console-logger";
import { DebugLogWriter } from "@/infra/logger/debug-log-writer";
import { JsonLogWriter } from "@/infra/logger/json-log-writer";
import { NdjsonFileLogger } from "@/infra/logger/ndjson-file-logger";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { PlanFileStore, PlanFileStoreAdapter } from "@/infra/planning/plan-file-store";
import { CcSddAdapter } from "@/infra/sdd/cc-sdd-adapter";
import { MockSddAdapter } from "@/infra/sdd/mock-sdd-adapter";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import {
  dependencyGraphTool,
  findReferencesTool,
  findSymbolDefinitionTool,
  parseTsAstTool,
} from "@/infra/tools/code-analysis";
import { listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from "@/infra/tools/filesystem";
import {
  gitAddTool,
  gitBranchCreateTool,
  gitBranchListTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  gitStatusTool,
} from "@/infra/tools/git";
import { retrieveDesignDocTool, retrieveSpecTool, searchMemoryTool } from "@/infra/tools/knowledge";
import { installDependenciesTool, runCommandTool, runTestSuiteTool } from "@/infra/tools/shell";
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
  private _logger?: ILogger;
  private _toolContextLogger?: ToolContextLogger;
  private _toolRegistry?: ToolRegistry;
  private _permissionSystem?: PermissionSystem;
  private _toolContext?: ToolContext;
  private _toolExecutor?: ToolExecutor;
  private _agentLoop?: AgentLoopService;
  private _gitController?: IGitController;
  private _planStore?: PlanFileStoreAdapter;
  private _implementationLoop?: IImplementationLoop;
  private _memory?: FileMemoryStore;
  private _useCase?: RunSpecUseCase;
  private _frameworkDefinitionLoader?: FrameworkDefinitionPort;
  private _frameworkDefinition?: FrameworkDefinition;

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
      if (this.options.debugLog !== undefined) {
        this._logger = new NdjsonFileLogger(this.options.debugLog, minLevel);
      } else {
        const isTTY = process.env.NO_COLOR !== undefined
          ? false
          : process.env.FORCE_COLOR !== undefined
          ? true
          : process.stderr.isTTY === true;
        this._logger = new ConsoleLogger(minLevel, isTTY);
      }
    }
    return this._logger;
  }

  private get toolContextLogger(): ToolContextLogger {
    if (!this._toolContextLogger) {
      this._toolContextLogger = new ToolContextLogger(this.logger);
    }
    return this._toolContextLogger;
  }

  private get toolRegistry(): ToolRegistry {
    if (!this._toolRegistry) {
      const registry = new ToolRegistry();
      for (
        const tool of [
          readFileTool,
          writeFileTool,
          listDirectoryTool,
          searchFilesTool,
          runCommandTool,
          runTestSuiteTool,
          installDependenciesTool,
          gitStatusTool,
          gitDiffTool,
          gitCommitTool,
          gitBranchListTool,
          gitBranchCreateTool,
          gitBranchSwitchTool,
          gitAddTool,
          gitPushTool,
          searchMemoryTool,
          retrieveSpecTool,
          retrieveDesignDocTool,
          parseTsAstTool,
          findSymbolDefinitionTool,
          findReferencesTool,
          dependencyGraphTool,
        ]
      ) {
        registry.register(tool);
      }
      this._toolRegistry = registry;
    }
    return this._toolRegistry;
  }

  private get permissionSystem(): PermissionSystem {
    if (!this._permissionSystem) {
      this._permissionSystem = new PermissionSystem();
    }
    return this._permissionSystem;
  }

  private get toolContext(): ToolContext {
    if (!this._toolContext) {
      this._toolContext = {
        workspaceRoot: process.cwd(),
        workingDirectory: process.cwd(),
        permissions: this.permissionSystem.resolvePermissionSet("Full"),
        memory: {
          async search() {
            return [];
          },
        },
        logger: this.toolContextLogger,
      };
    }
    return this._toolContext;
  }

  private get toolExecutor(): ToolExecutor {
    if (!this._toolExecutor) {
      this._toolExecutor = new ToolExecutor(this.toolRegistry, this.permissionSystem, {
        defaultTimeoutMs: 60_000,
        logMaxInputBytes: 1024,
      });
    }
    return this._toolExecutor;
  }

  private get agentLoop(): AgentLoopService {
    if (!this._agentLoop) {
      this._agentLoop = new AgentLoopService(
        this.toolExecutor,
        this.toolRegistry,
        this.newLlmProvider(),
        this.toolContext,
      );
    }
    return this._agentLoop;
  }

  private get gitController(): IGitController {
    if (!this._gitController) {
      this._gitController = this.options.debug
        ? {
          listBranches: async () => ({ ok: true, value: [] }),
          detectChanges: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [] } }),
          createAndCheckoutBranch: async (_name, _base) => ({
            ok: true,
            value: { branchName: _name, baseBranch: _base, conflictResolved: false },
          }),
          stageAndCommit: async (_files, _msg) => ({
            ok: true,
            value: { hash: "mock-sha-0000000", message: _msg, fileCount: 0 },
          }),
          push: async (_name: string, _remote: string) => ({
            ok: true,
            value: { branchName: _name, remote: _remote, commitHash: "mock-sha-0000000" },
          }),
        }
        : new GitControllerAdapter(this.toolExecutor, new GitValidator(), this.toolContext, []);
    }
    return this._gitController;
  }

  private get planStore(): PlanFileStoreAdapter {
    if (!this._planStore) {
      this._planStore = new PlanFileStoreAdapter(new PlanFileStore({ baseDir: process.cwd() }));
    }
    return this._planStore;
  }

  private get implementationLoop(): IImplementationLoop {
    if (!this._implementationLoop) {
      const qualityGate = new QualityGateRunner(this.toolExecutor, this.toolContext);
      const reviewEngine = new LlmReviewEngineService(this.newLlmProvider(), qualityGate);
      this._implementationLoop = new ImplementationLoopService(
        this.planStore,
        this.agentLoop,
        reviewEngine,
        this.gitController,
      );
    }
    return this._implementationLoop;
  }

  private get memory(): FileMemoryStore {
    if (!this._memory) {
      this._memory = new FileMemoryStore({ baseDir: process.cwd() });
    }
    return this._memory;
  }

  private get frameworkDefinitionLoader(): FrameworkDefinitionPort {
    if (!this._frameworkDefinitionLoader) {
      this._frameworkDefinitionLoader = new TypeScriptFrameworkDefinitionLoader();
    }
    return this._frameworkDefinitionLoader;
  }

  private get frameworkDefinition(): FrameworkDefinition {
    if (this._frameworkDefinition === undefined) {
      throw new Error("frameworkDefinition accessed before build() completed");
    }
    return this._frameworkDefinition;
  }

  private get useCase(): RunSpecUseCase {
    if (!this._useCase) {
      const debugApprovalGate = this.debugApprovalGate;
      const debugAgentEventBus = this.debugAgentEventBus;
      this._useCase = new RunSpecUseCase({
        stateStore: new WorkflowStateStore(),
        eventBus: this.eventBus,
        sdd: this.options.debug ? new MockSddAdapter(this.debugWriter ?? undefined) : new CcSddAdapter(),
        frameworkDefinition: this.frameworkDefinition,
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
  async build(): Promise<RunDependencies> {
    // Load the framework definition first; propagates loader errors (e.g. unknown framework ID)
    // so startup fails fast with a helpful message listing available frameworks.
    this._frameworkDefinition = await this.frameworkDefinitionLoader.load(this.config.sddFramework);

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
