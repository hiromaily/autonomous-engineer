#!/usr/bin/env bun
import { ClaudeProvider } from "@/adapters/llm/claude-provider";
import { MockLlmProvider } from "@/adapters/llm/mock-llm-provider";
import { CcSddAdapter } from "@/adapters/sdd/cc-sdd-adapter";
import { MockSddAdapter } from "@/adapters/sdd/mock-sdd-adapter";
import { DebugAgentEventBus } from "@/application/agent/debug-agent-event-bus";
import { ConfigValidationError } from "@/application/ports/config";
import type { AesConfig } from "@/application/ports/config";
import type { LlmProviderPort } from "@/application/ports/llm";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { DebugApprovalGate } from "@/application/workflow/debug-approval-gate";
import { ConfigLoader } from "@/infra/config/config-loader";
import { ConfigWriter } from "@/infra/config/config-writer";
import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { createImplementationLoopService } from "@/infra/implementation-loop/create-implementation-loop-service";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import { defineCommand, runMain } from "citty";
import { ConfigWizard } from "./config-wizard";
import { ConfigureCommand } from "./configure-command";
import { DebugLogWriter } from "./debug-log-writer";
import { JsonLogWriter } from "./json-log-writer";
import { CliRenderer } from "./renderer";

const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a spec workflow",
  },
  args: {
    specName: {
      type: "positional",
      description: "Name of the spec to run",
      required: true,
    },
    provider: {
      type: "string",
      description: "Override the LLM provider",
    },
    "dry-run": {
      type: "boolean",
      description: "Validate spec and config without running the workflow",
      default: false,
    },
    "log-json": {
      type: "string",
      description: "Write workflow events as NDJSON to this file",
    },
    "debug-flow": {
      type: "boolean",
      description: "Run with a mock LLM, auto-approve gates, and emit debug logs",
      default: false,
    },
    "debug-flow-log": {
      type: "string",
      description: "Write debug events as NDJSON to this file (default: stderr)",
    },
  },
  async run({ args }) {
    const specName = args.specName as string;

    if (!specName || specName.trim() === "") {
      process.stderr.write("Error: spec name is required\n");
      process.exit(1);
    }

    const debugFlow = Boolean(args["debug-flow"]);
    const debugFlowLog = args["debug-flow-log"] as string | undefined;

    // Load configuration
    const configLoader = new ConfigLoader();
    let config: AesConfig;
    try {
      config = await configLoader.load();
    } catch (err) {
      if (err instanceof ConfigValidationError && debugFlow) {
        // In debug-flow mode, bypass all llm.* validation since MockLlmProvider doesn't use them.
        const nonLlmMissingFields = err.missingFields.filter((f) => !f.startsWith("llm."));
        if (nonLlmMissingFields.length > 0) {
          process.stderr.write(`Error: configuration missing required fields: ${nonLlmMissingFields.join(", ")}\n`);
          process.exit(1);
        }
        // Reload with placeholder LLM values so that non-LLM user settings from aes.config.json are preserved.
        process.stderr.write(
          "[DEBUG-FLOW] Config validation for LLM fields skipped; using placeholder values.\n",
        );
        config = await new ConfigLoader(process.cwd(), {
          ...process.env,
          AES_LLM_API_KEY: "__debug__",
          AES_LLM_PROVIDER: "claude",
          AES_LLM_MODEL_NAME: "__debug__",
        }).load();
      } else if (err instanceof ConfigValidationError) {
        if (err.missingFields.includes("llm.apiKey")) {
          process.stderr.write("Warning: AES_LLM_API_KEY environment variable is not set.\n");
        }
        process.stderr.write(`Error: configuration missing required fields: ${err.missingFields.join(", ")}\n`);
        process.stderr.write("Run 'aes configure' to set up your configuration.\n");
        process.exit(1);
      } else {
        process.stderr.write(
          `Error: failed to load configuration: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }

    // Set up event bus and subscribers
    const eventBus = new WorkflowEventBus();
    const renderer = new CliRenderer((text) => process.stdout.write(text));
    eventBus.on((event) => renderer.handle(event));

    // Set up optional JSON log writer
    const logJsonPath = args["log-json"] as string | undefined;
    let logWriter: JsonLogWriter | null = null;
    if (logJsonPath) {
      logWriter = new JsonLogWriter(logJsonPath);
      const writer = logWriter;
      eventBus.on((event) => {
        writer.write(event).catch((err) => {
          process.stderr.write(
            `Warning: failed to write to log file: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
      });
    }

    // Set up debug-flow components
    let debugWriter: DebugLogWriter | null = null;
    let debugApprovalGate: DebugApprovalGate | null = null;
    let debugAgentEventBus: DebugAgentEventBus | null = null;

    if (debugFlow) {
      process.stderr.write("[DEBUG-FLOW MODE] Running with mock LLM and auto-approved gates.\n");
      debugWriter = new DebugLogWriter(debugFlowLog);
      debugApprovalGate = new DebugApprovalGate(debugWriter);
      debugAgentEventBus = new DebugAgentEventBus({ sink: debugWriter, workflowEventBus: eventBus });
    }

    // Build use case with injected deps
    const memory = new FileMemoryStore({ baseDir: process.cwd() });

    // Create implementation loop LLM (separate instance so the loop has its own context)
    const implLlm: LlmProviderPort = debugFlow && debugWriter
      ? new MockLlmProvider({
        sink: debugWriter,
        workflowEventBus: eventBus,
      })
      : new ClaudeProvider({ apiKey: config.llm.apiKey, modelName: config.llm.modelName });

    const implementationLoop = createImplementationLoopService({
      llm: implLlm,
      workspaceRoot: process.cwd(),
      noOpGit: debugFlow,
    });

    const useCase = new RunSpecUseCase({
      stateStore: new WorkflowStateStore(),
      eventBus,
      sdd: debugFlow ? new MockSddAdapter(debugWriter ?? undefined) : new CcSddAdapter(),
      memory,
      implementationLoop,
      createLlmProvider: (cfg: AesConfig, providerOverride?: string): LlmProviderPort => {
        if (debugFlow && debugWriter) {
          return new MockLlmProvider({
            sink: debugWriter,
            workflowEventBus: eventBus,
          });
        }
        const provider = providerOverride ?? cfg.llm.provider;
        switch (provider) {
          case "claude":
            return new ClaudeProvider({ apiKey: cfg.llm.apiKey, modelName: cfg.llm.modelName });
          default:
            throw new Error(`Unsupported LLM provider: '${provider}'`);
        }
      },
      ...(debugApprovalGate !== null ? { approvalGate: debugApprovalGate } : {}),
      ...(debugAgentEventBus !== null ? { implementationLoopOptions: { agentEventBus: debugAgentEventBus } } : {}),
    });

    const providerArg = args.provider as string | undefined;
    const result = await useCase.run(specName, config, {
      dryRun: Boolean(args["dry-run"]),
      providerOverride: providerArg,
    });

    // Flush JSON log and debug log in parallel
    await Promise.all([logWriter?.close(), debugWriter?.close()]);

    if (result.status === "failed") {
      process.exit(1);
    }
  },
});

const configureCommand = defineCommand({
  meta: {
    name: "configure",
    description: "Interactively configure aes settings",
  },
  async run() {
    const cmd = new ConfigureCommand({
      wizard: new ConfigWizard(),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
    });
    await cmd.run();
  },
});

const mainCommand = defineCommand({
  meta: {
    name: "aes",
    description: "Autonomous Engineer System CLI",
    version: "0.1.0",
  },
  subCommands: {
    run: runCommand,
    configure: configureCommand,
  },
});

runMain(mainCommand);
