// ---------------------------------------------------------------------------
// createGitIntegrationService — infra/git/create-git-integration-service.ts
//
// Composition root factory for the git-integration feature.
// Constructs all components and wires them together.
// ---------------------------------------------------------------------------

import { GitControllerAdapter } from "../../adapters/git/git-controller-adapter";
import { GitHubPrAdapter } from "../../adapters/git/github-pr-adapter";
import type { IPullRequestProvider } from "../../application/ports/pr-provider";
import type { IAuditLogger } from "../../application/safety/ports";
import type { LlmProviderPort } from "../../application/ports/llm";
import type { IToolExecutor } from "../../application/tools/executor";
import {
  GitIntegrationService,
  type IGitIntegrationService,
} from "../../application/git/git-integration-service";
import { GitValidator } from "../../domain/git/git-validator";
import type { GitIntegrationConfig } from "../../domain/git/types";
import type { ToolContext } from "../../domain/tools/types";
import { GitEventBus } from "../events/git-event-bus";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitIntegrationServiceOptions {
  /** Git integration configuration (loaded from ConfigLoader.loadGitIntegrationConfig). */
  readonly config: GitIntegrationConfig;

  /** The tool executor (safety-wrapped or bare) for invoking git CLI tools. */
  readonly toolExecutor: IToolExecutor;

  /** LLM provider for commit message and PR body generation. */
  readonly llm: LlmProviderPort;

  /** Audit logger for recording git operations. */
  readonly auditLogger: IAuditLogger;

  /** Tool context carrying workspace root, permissions, memory, and logger. */
  readonly toolContext: ToolContext;

  /**
   * GitHub personal access token with 'repo' scope.
   * When omitted, `createOrUpdatePullRequest` will return a permission error.
   */
  readonly githubToken?: string;

  /** GitHub repository owner (user or org). Required when githubToken is provided. */
  readonly githubOwner?: string;

  /** GitHub repository name. Required when githubToken is provided. */
  readonly githubRepo?: string;

  /**
   * Optional session ID for audit log entries.
   * Defaults to "default".
   */
  readonly sessionId?: string;
}

/**
 * Composition root factory for the git-integration feature.
 *
 * 1. Constructs GitValidator (pure domain logic, no I/O).
 * 2. Constructs GitControllerAdapter (delegates all git CLI ops to IToolExecutor).
 * 3. Constructs GitHubPrAdapter if a GitHub token is provided.
 * 4. Constructs GitEventBus (in-process synchronous event bus).
 * 5. Constructs GitIntegrationService with all injected dependencies.
 * 6. Returns the service as IGitIntegrationService.
 *
 * Callers should subscribe to the returned eventBus to observe git events.
 */
export function createGitIntegrationService(
  options: GitIntegrationServiceOptions,
): IGitIntegrationService {
  const {
    config,
    toolExecutor,
    llm,
    auditLogger,
    toolContext,
    githubToken,
    githubOwner,
    githubRepo,
    sessionId = "default",
  } = options;

  // 1. Domain: pure validator with no I/O
  const validator = new GitValidator();

  // 2. Adapter: git CLI operations via IToolExecutor
  const gitController = new GitControllerAdapter(
    toolExecutor,
    validator,
    toolContext,
    config.protectedFilePatterns,
  );

  // 3. Adapter: PR creation via GitHub REST API (optional)
  const prProvider: IPullRequestProvider = githubToken && githubOwner && githubRepo
    ? new GitHubPrAdapter({
        apiBaseUrl: "https://api.github.com",
        owner: githubOwner,
        repo: githubRepo,
        token: githubToken,
      })
    : makeNoOpPrProvider();

  // 4. Infra: in-process synchronous event bus
  const eventBus = new GitEventBus();

  // 5. Application: orchestration service
  const service = new GitIntegrationService(
    gitController,
    prProvider,
    llm,
    eventBus,
    auditLogger,
    validator,
    config,
    sessionId,
    toolContext.permissions,
  );

  return service;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns a no-op IPullRequestProvider that always returns a permission error.
 * Used when no GitHub token is configured.
 */
function makeNoOpPrProvider(): IPullRequestProvider {
  return {
    createOrUpdate: async (_params) => ({
      ok: false,
      error: {
        category: "auth",
        message:
          "No GitHub token configured. Set AES_GITHUB_TOKEN, AES_GITHUB_OWNER, and AES_GITHUB_REPO to enable PR creation.",
      },
    }),
  };
}
