#!/usr/bin/env bun
import { ClaudeProvider } from "@/adapters/llm/claude-provider";
import { CcSddAdapter } from "@/adapters/sdd/cc-sdd-adapter";
import { ConfigValidationError } from "@/application/ports/config";
import type { AesConfig } from "@/application/ports/config";
import type { LlmProviderPort } from "@/application/ports/llm";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { ConfigLoader } from "@/infra/config/config-loader";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";
import { defineCommand, runMain } from "citty";
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
    resume: {
      type: "boolean",
      description: "Resume from the last persisted state",
      default: false,
    },
    "log-json": {
      type: "string",
      description: "Write workflow events as NDJSON to this file",
    },
  },
  async run({ args }) {
    const specName = args.specName as string;

    if (!specName || specName.trim() === "") {
      process.stderr.write("Error: spec name is required\n");
      process.exit(1);
    }

    // Load configuration
    const configLoader = new ConfigLoader();
    let config: AesConfig;
    try {
      config = await configLoader.load();
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        process.stderr.write(`Error: configuration missing required fields: ${err.missingFields.join(", ")}\n`);
      } else {
        process.stderr.write(
          `Error: failed to load configuration: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.exit(1);
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

    // Build use case with injected deps
    const memory = new FileMemoryStore({ baseDir: process.cwd() });
    const useCase = new RunSpecUseCase({
      stateStore: new WorkflowStateStore(),
      eventBus,
      sdd: new CcSddAdapter(),
      memory,
      createLlmProvider: (cfg: AesConfig, providerOverride?: string): LlmProviderPort => {
        const provider = providerOverride ?? cfg.llm.provider;
        switch (provider) {
          case "claude":
            return new ClaudeProvider({ apiKey: cfg.llm.apiKey, modelName: cfg.llm.modelName });
          default:
            throw new Error(`Unsupported LLM provider: '${provider}'`);
        }
      },
    });

    const providerArg = args.provider as string | undefined;
    const result = await useCase.run(specName, config, {
      resume: Boolean(args.resume),
      dryRun: Boolean(args["dry-run"]),
      providerOverride: providerArg,
    });

    // Flush JSON log
    if (logWriter) {
      await logWriter.close();
    }

    if (result.status === "failed") {
      process.exit(1);
    }
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
  },
});

runMain(mainCommand);
