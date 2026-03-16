import { DebugLogWriter } from "@/adapters/cli/debug-log-writer";
import { JsonLogWriter } from "@/adapters/cli/json-log-writer";
import { DebugAgentEventBus } from "@/application/agent/debug-agent-event-bus";
import type { AesConfig } from "@/application/ports/config";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IJsonLogWriter } from "@/application/ports/logging";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import { DebugApprovalGate } from "@/application/workflow/debug-approval-gate";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { createImplementationLoopService } from "@/infra/implementation-loop/create-implementation-loop-service";
import { ClaudeProvider } from "@/infra/llm/claude-provider";
import { MockLlmProvider } from "@/infra/llm/mock-llm-provider";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { CcSddAdapter } from "@/infra/sdd/cc-sdd-adapter";
import { MockSddAdapter } from "@/infra/sdd/mock-sdd-adapter";
import { WorkflowStateStore } from "@/infra/state/workflow-state-store";

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

export function createRunDependencies(
  config: AesConfig,
  options: RunOptions,
): RunDependencies {
  const { debugFlow, debugFlowLog, logJsonPath } = options;

  const eventBus = new WorkflowEventBus();

  // Optional JSON log writer
  const logWriter: IJsonLogWriter | null = logJsonPath !== undefined
    ? new JsonLogWriter(logJsonPath)
    : null;

  if (logWriter !== null) {
    const writer = logWriter;
    eventBus.on((event) => {
      writer.write(event).catch((err) => {
        process.stderr.write(
          `Warning: failed to write to log file: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    });
  }

  // Debug-flow components
  let debugWriter: IDebugEventSink | null = null;
  let debugApprovalGate: DebugApprovalGate | null = null;
  let debugAgentEventBus: DebugAgentEventBus | null = null;

  if (debugFlow) {
    debugWriter = new DebugLogWriter(debugFlowLog);
    debugApprovalGate = new DebugApprovalGate(debugWriter);
    debugAgentEventBus = new DebugAgentEventBus({ sink: debugWriter, workflowEventBus: eventBus });
  }

  // Implementation loop LLM
  const implLlm: LlmProviderPort = debugFlow && debugWriter !== null
    ? new MockLlmProvider({ sink: debugWriter, workflowEventBus: eventBus })
    : new ClaudeProvider({ apiKey: config.llm.apiKey, modelName: config.llm.modelName });

  const implementationLoop = createImplementationLoopService({
    llm: implLlm,
    workspaceRoot: process.cwd(),
    noOpGit: debugFlow,
  });

  const memory = new FileMemoryStore({ baseDir: process.cwd() });

  const useCase = new RunSpecUseCase({
    stateStore: new WorkflowStateStore(),
    eventBus,
    sdd: debugFlow ? new MockSddAdapter(debugWriter ?? undefined) : new CcSddAdapter(),
    memory,
    implementationLoop,
    createLlmProvider: (cfg: AesConfig, providerOverride?: string): LlmProviderPort => {
      if (debugFlow && debugWriter !== null) {
        return new MockLlmProvider({ sink: debugWriter, workflowEventBus: eventBus });
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

  return { useCase, eventBus, logWriter, debugWriter };
}
