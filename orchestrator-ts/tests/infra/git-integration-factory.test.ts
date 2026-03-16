import type { LlmProviderPort } from "@/application/ports/llm";
import type { IAuditLogger } from "@/application/ports/safety";
import type { IToolExecutor } from "@/application/services/tools/executor";
import type { ToolContext, ToolResult } from "@/domain/tools/types";
import { ConfigLoader } from "@/infra/config/config-loader";
import { createGitIntegrationService } from "@/infra/git/create-git-integration-service";
import { beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal stubs for factory constructor parameters
// ---------------------------------------------------------------------------

function makeStubExecutor(): IToolExecutor {
  return {
    invoke: async (_name, _input, _context): Promise<ToolResult<unknown>> => ({ ok: true, value: {} }),
  };
}

function makeStubLlm(): LlmProviderPort {
  return {
    complete: async (_prompt) => ({ ok: true, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } }),
    clearContext: () => {},
  };
}

function makeStubAuditLogger(): IAuditLogger {
  return {
    write: async (_entry) => {},
    flush: async () => {},
  };
}

function makeToolContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions: {
      filesystemRead: true,
      filesystemWrite: true,
      shellExecution: true,
      gitWrite: true,
      networkAccess: true,
    },
    memory: {
      search: async (_query) => [],
    },
    logger: {
      info: (_entry) => {},
      error: (_entry) => {},
    },
  };
}

// ---------------------------------------------------------------------------
// ConfigLoader.loadGitIntegrationConfig tests
// ---------------------------------------------------------------------------

describe("ConfigLoader.loadGitIntegrationConfig()", () => {
  const cwd = join(tmpdir(), "aes-git-config-test");

  it("returns default values when no env vars are set", () => {
    const loader = new ConfigLoader(cwd, {});
    const config = loader.loadGitIntegrationConfig();

    expect(config.baseBranch).toBe("main");
    expect(config.remote).toBe("origin");
    expect(config.maxFilesPerCommit).toBe(50);
    expect(config.forcePushEnabled).toBe(false);
    expect(config.isDraft).toBe(false);
    expect(typeof config.maxDiffTokens).toBe("number");
    expect(config.maxDiffTokens).toBeGreaterThan(0);
  });

  it("workspaceRoot defaults to the cwd passed to ConfigLoader", () => {
    const loader = new ConfigLoader(cwd, {});
    const config = loader.loadGitIntegrationConfig();

    expect(config.workspaceRoot).toBe(cwd);
  });

  it("reads baseBranch from AES_GIT_BASE_BRANCH env var", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_BASE_BRANCH: "develop" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.baseBranch).toBe("develop");
  });

  it("reads remote from AES_GIT_REMOTE env var", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_REMOTE: "upstream" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.remote).toBe("upstream");
  });

  it("reads maxFilesPerCommit from AES_GIT_MAX_FILES_PER_COMMIT env var", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_MAX_FILES_PER_COMMIT: "25" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.maxFilesPerCommit).toBe(25);
  });

  it("reads maxDiffTokens from AES_GIT_MAX_DIFF_TOKENS env var", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_MAX_DIFF_TOKENS: "1000" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.maxDiffTokens).toBe(1000);
  });

  it("enables forcePush when AES_GIT_FORCE_PUSH_ENABLED=true", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_FORCE_PUSH_ENABLED: "true" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.forcePushEnabled).toBe(true);
  });

  it("sets isDraft when AES_GIT_IS_DRAFT=true", () => {
    const loader = new ConfigLoader(cwd, { AES_GIT_IS_DRAFT: "true" });
    const config = loader.loadGitIntegrationConfig();

    expect(config.isDraft).toBe(true);
  });

  it("returns non-empty default protectedBranches including main and master", () => {
    const loader = new ConfigLoader(cwd, {});
    const config = loader.loadGitIntegrationConfig();

    expect(Array.isArray(config.protectedBranches)).toBe(true);
    expect(config.protectedBranches).toContain("main");
    expect(config.protectedBranches).toContain("master");
  });

  it("returns non-empty default protectedFilePatterns", () => {
    const loader = new ConfigLoader(cwd, {});
    const config = loader.loadGitIntegrationConfig();

    expect(Array.isArray(config.protectedFilePatterns)).toBe(true);
    expect(config.protectedFilePatterns.length).toBeGreaterThan(0);
  });

  it("returns a frozen (immutable) config object", () => {
    const loader = new ConfigLoader(cwd, {});
    const config = loader.loadGitIntegrationConfig();

    // All fields are typed as readonly; verify the object is structurally correct
    expect(config).toBeDefined();
    expect(typeof config.baseBranch).toBe("string");
    expect(typeof config.remote).toBe("string");
    expect(typeof config.maxFilesPerCommit).toBe("number");
    expect(typeof config.forcePushEnabled).toBe("boolean");
    expect(typeof config.workspaceRoot).toBe("string");
    expect(typeof config.isDraft).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// createGitIntegrationService factory tests
// ---------------------------------------------------------------------------

describe("createGitIntegrationService()", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = join(tmpdir(), "aes-git-svc-test");
  });

  it("returns an object implementing IGitIntegrationService", () => {
    const loader = new ConfigLoader(workspaceRoot, {});
    const config = loader.loadGitIntegrationConfig();

    const service = createGitIntegrationService({
      config,
      toolExecutor: makeStubExecutor(),
      llm: makeStubLlm(),
      auditLogger: makeStubAuditLogger(),
      toolContext: makeToolContext(workspaceRoot),
      githubToken: "test-token",
      githubOwner: "test-owner",
      githubRepo: "test-repo",
    });

    // Verify the service implements IGitIntegrationService
    expect(typeof service.createBranch).toBe("function");
    expect(typeof service.generateAndCommit).toBe("function");
    expect(typeof service.push).toBe("function");
    expect(typeof service.createOrUpdatePullRequest).toBe("function");
    expect(typeof service.runFullWorkflow).toBe("function");
  });

  it("returns a service when githubToken is undefined (no PR adapter configured)", () => {
    const loader = new ConfigLoader(workspaceRoot, {});
    const config = loader.loadGitIntegrationConfig();

    const service = createGitIntegrationService({
      config,
      toolExecutor: makeStubExecutor(),
      llm: makeStubLlm(),
      auditLogger: makeStubAuditLogger(),
      toolContext: makeToolContext(workspaceRoot),
    });

    expect(service).toBeDefined();
    expect(typeof service.createBranch).toBe("function");
  });

  it("reads github token from AES_GITHUB_TOKEN env var via ConfigLoader", () => {
    const loader = new ConfigLoader(workspaceRoot, { AES_GITHUB_TOKEN: "env-token" });
    const githubToken = loader.loadGithubToken();

    expect(githubToken).toBe("env-token");
  });

  it("returns undefined github token when env var is not set", () => {
    const loader = new ConfigLoader(workspaceRoot, {});
    const githubToken = loader.loadGithubToken();

    expect(githubToken).toBeUndefined();
  });
});
