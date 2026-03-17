import type { ToolContext, ToolResult } from "@/domain/tools/types";

/**
 * Port interface for the tool execution pipeline.
 * Used by services (AgentLoopService, QualityGateRunner, etc.) and by infra adapters
 * (GitControllerAdapter) that delegate CLI operations to the executor.
 */
export interface IToolExecutor {
  invoke(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult<unknown>>;
}
