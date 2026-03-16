#!/usr/bin/env bun
import { ConfigValidationError } from "@/application/ports/config";
import type { AesConfig } from "@/application/ports/config";
import { createConfigureDependencies } from "@/infra/bootstrap/create-configure-dependencies";
import { createRunDependencies } from "@/infra/bootstrap/create-run-dependencies";
import { ConfigLoader } from "@/infra/bootstrap/load-config";
import { defineCommand, runMain } from "citty";
import { ConfigWizard } from "./config-wizard";
import { ConfigureCommand } from "./configure-command";
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
        const nonLlmMissingFields = err.missingFields.filter((f) => !f.startsWith("llm."));
        if (nonLlmMissingFields.length > 0) {
          process.stderr.write(`Error: configuration missing required fields: ${nonLlmMissingFields.join(", ")}\n`);
          process.exit(1);
        }
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

    if (debugFlow) {
      process.stderr.write("[DEBUG-FLOW MODE] Running with mock LLM and auto-approved gates.\n");
    }

    // Wire dependencies via bootstrap
    const logJsonPath = args["log-json"] as string | undefined;
    const providerOverride = args.provider as string | undefined;
    const { useCase, eventBus, logWriter, debugWriter } = createRunDependencies(config, {
      debugFlow,
      ...(debugFlowLog !== undefined ? { debugFlowLog } : {}),
      ...(logJsonPath !== undefined ? { logJsonPath } : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
    });

    // Attach renderer
    const renderer = new CliRenderer((text) => process.stdout.write(text));
    eventBus.on((event) => renderer.handle(event));

    const result = await useCase.run(specName, config, {
      dryRun: Boolean(args["dry-run"]),
      providerOverride: args.provider as string | undefined,
    });

    // Flush log writers in parallel
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
    const { configWriter, frameworkChecker } = createConfigureDependencies();
    const cmd = new ConfigureCommand({
      wizard: new ConfigWizard(),
      configWriter,
      frameworkChecker,
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
