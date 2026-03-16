// ---------------------------------------------------------------------------
// createImplementationLoopService — composition root for the implementation loop
// ---------------------------------------------------------------------------

import { GitControllerAdapter } from "@/adapters/git/git-controller-adapter";
import {
  dependencyGraphTool,
  findReferencesTool,
  findSymbolDefinitionTool,
  parseTsAstTool,
} from "@/adapters/tools/code-analysis";
import { listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from "@/adapters/tools/filesystem";
import {
  gitAddTool,
  gitBranchCreateTool,
  gitBranchListTool,
  gitBranchSwitchTool,
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  gitStatusTool,
} from "@/adapters/tools/git";
import { retrieveDesignDocTool, retrieveSpecTool, searchMemoryTool } from "@/adapters/tools/knowledge";
import { installDependenciesTool, runCommandTool, runTestSuiteTool } from "@/adapters/tools/shell";
import { AgentLoopService } from "@/application/agent/agent-loop-service";
import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import { LlmReviewEngineService } from "@/application/implementation-loop/llm-review-engine";
import { QualityGateRunner } from "@/application/implementation-loop/quality-gate-runner";
import type { IGitController } from "@/application/ports/git-controller";
import type { IImplementationLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import { ToolExecutor } from "@/application/tools/executor";
import { GitValidator } from "@/domain/git/git-validator";
import { PermissionSystem } from "@/domain/tools/permissions";
import { ToolRegistry } from "@/domain/tools/registry";
import type { ToolContext } from "@/domain/tools/types";
import { PlanFileStore, PlanFileStoreAdapter } from "@/infra/planning/plan-file-store";

export interface ImplementationLoopServiceOptions {
  readonly llm: LlmProviderPort;
  readonly workspaceRoot: string;
  /**
   * When true, replaces the real GitControllerAdapter with a no-op stub that
   * reports no changes and returns a synthetic commit SHA. Used in --debug-flow
   * so the implementation loop completes without touching the actual git repo.
   */
  readonly noOpGit?: boolean;
}

/**
 * Composition root factory for the implementation loop feature.
 *
 * 1. Creates ToolRegistry populated with all available tool adapters.
 * 2. Creates PermissionSystem and resolves Full permission set.
 * 3. Constructs ToolContext (workspaceRoot, permissions, no-op memory/logger).
 * 4. Creates ToolExecutor (bare, wrapping registry + permission system).
 * 5. Creates AgentLoopService, LlmReviewEngineService, GitControllerAdapter, PlanFileStoreAdapter.
 * 6. Returns fully wired ImplementationLoopService.
 */
export function createImplementationLoopService(
  options: ImplementationLoopServiceOptions,
): IImplementationLoop {
  const { llm, workspaceRoot, noOpGit = false } = options;

  // 1. Tool registry — all available tools registered once
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

  // 2. Permission system — Full mode grants all flags
  const permSystem = new PermissionSystem();
  const permissionSet = permSystem.resolvePermissionSet("Full");

  // 3. Tool context
  const toolContext: ToolContext = {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions: permissionSet,
    memory: {
      async search() {
        return [];
      },
    },
    logger: {
      info() {},
      error(entry) {
        process.stderr.write(`[TOOL ERROR] ${entry.toolName}: ${entry.errorMessage ?? "error"}\n`);
      },
    },
  };

  // 4. Tool executor
  const executor = new ToolExecutor(registry, permSystem, {
    defaultTimeoutMs: 60_000,
    logMaxInputBytes: 1024,
  });

  // 5. Agent loop
  const agentLoop = new AgentLoopService(executor, registry, llm, toolContext);

  // 6. Quality gate runner + review engine
  const qualityGate = new QualityGateRunner(executor, toolContext);
  const reviewEngine = new LlmReviewEngineService(llm, qualityGate);

  // 7. Git controller
  const gitController: IGitController = noOpGit
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
    : new GitControllerAdapter(executor, new GitValidator(), toolContext, []);

  // 8. Plan store
  const planStore = new PlanFileStoreAdapter(new PlanFileStore({ baseDir: workspaceRoot }));

  return new ImplementationLoopService(planStore, agentLoop, reviewEngine, gitController);
}
