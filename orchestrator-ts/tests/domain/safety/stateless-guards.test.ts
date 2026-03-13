import { describe, expect, it } from "bun:test";
import type { SafetyContext } from "../../../domain/safety/guards";
import {
  FilesystemGuard,
  GitSafetyGuard,
  ShellRestrictionGuard,
  WorkspaceIsolationGuard,
} from "../../../domain/safety/stateless-guards";
import { createSafetyConfig, createSafetySession } from "../../../domain/safety/types";
import type { MemoryEntry } from "../../../domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSafetyContext(overrides: Parameters<typeof createSafetyConfig>[0]): SafetyContext {
  const config = createSafetyConfig(overrides);
  const session = createSafetySession();
  return {
    workspaceRoot: config.workspaceRoot,
    workingDirectory: config.workspaceRoot,
    permissions: {
      filesystemRead: true,
      filesystemWrite: true,
      shellExecution: true,
      gitWrite: true,
      networkAccess: false,
    },
    memory: {
      async search(_q: string): Promise<ReadonlyArray<MemoryEntry>> {
        return [];
      },
    },
    logger: { info: () => {}, error: () => {} },
    session,
    config,
  };
}

// ---------------------------------------------------------------------------
// 2.1 WorkspaceIsolationGuard
// ---------------------------------------------------------------------------

describe("WorkspaceIsolationGuard", () => {
  const guard = new WorkspaceIsolationGuard();
  const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });

  describe("read_file", () => {
    it("allows path inside workspace", async () => {
      const result = await guard.check("read_file", { path: "/workspace/src/index.ts" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows path at workspace root", async () => {
      const result = await guard.check("read_file", { path: "/workspace" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows relative path resolving inside workspace", async () => {
      const result = await guard.check("read_file", { path: "src/index.ts" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects path traversal sequence that escapes workspace", async () => {
      const result = await guard.check("read_file", { path: "../../../etc/passwd" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects absolute path outside workspace", async () => {
      const result = await guard.check("read_file", { path: "/etc/hosts" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects path that uses workspace name as prefix trick", async () => {
      const ctx2 = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("read_file", { path: "/workspace-evil/secret" }, ctx2);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });
  });

  describe("write_file", () => {
    it("allows path inside workspace", async () => {
      const result = await guard.check("write_file", { path: "/workspace/out.txt", content: "hi" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects path outside workspace", async () => {
      const result = await guard.check("write_file", { path: "/tmp/evil.sh", content: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });
  });

  describe("list_directory", () => {
    it("allows directory inside workspace", async () => {
      const result = await guard.check("list_directory", { path: "/workspace/src" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects directory outside workspace", async () => {
      const result = await guard.check("list_directory", { path: "/home/user" }, ctx);
      expect(result.allowed).toBe(false);
    });
  });

  describe("search_files", () => {
    it("allows directory field inside workspace", async () => {
      const result = await guard.check("search_files", { pattern: "*.ts", directory: "/workspace/src" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects directory field outside workspace", async () => {
      const result = await guard.check("search_files", { pattern: "*", directory: "/etc" }, ctx);
      expect(result.allowed).toBe(false);
    });
  });

  describe("run_command (shell tool)", () => {
    it("allows when cwd is inside workspace", async () => {
      const result = await guard.check("run_command", { command: "ls", args: [], cwd: "/workspace/src" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects when cwd is outside workspace", async () => {
      const result = await guard.check("run_command", { command: "ls", args: [], cwd: "/tmp" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("allows when cwd is absent (no path field to check)", async () => {
      const result = await guard.check("run_command", { command: "ls", args: [] }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("git tools (no file path inputs — pass through)", () => {
    it("allows git_commit (no file path field)", async () => {
      const result = await guard.check("git_commit", { message: "fix: bug" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows git_branch_create (no file path field)", async () => {
      const result = await guard.check("git_branch_create", { name: "agent/my-feature" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("unknown tools (pass through)", () => {
    it("allows unknown tools without path fields", async () => {
      const result = await guard.check("some_unknown_tool", { data: "foo" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2.2 FilesystemGuard
// ---------------------------------------------------------------------------

describe("FilesystemGuard", () => {
  const guard = new FilesystemGuard();
  const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });

  describe("write operations on default protected patterns", () => {
    it("rejects write to .env", async () => {
      const result = await guard.check("write_file", { path: "/workspace/.env", content: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects write to secrets.json", async () => {
      const result = await guard.check("write_file", { path: "/workspace/secrets.json", content: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects write to .git/config (directory-anchored pattern)", async () => {
      const result = await guard.check("write_file", { path: "/workspace/.git/config", content: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects write to .env.local", async () => {
      const result = await guard.check("write_file", { path: "/workspace/.env.local", content: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("rejects write to nested .env file", async () => {
      const result = await guard.check("write_file", { path: "/workspace/config/.env", content: "" }, ctx);
      expect(result.allowed).toBe(false);
    });
  });

  describe("operator-added protected patterns", () => {
    it("rejects write to operator-added pattern", async () => {
      const ctxWithCustom = makeSafetyContext({
        workspaceRoot: "/workspace",
        protectedFilePatterns: [".env", "secrets.json", ".git/config", "private.key"],
      });
      const result = await guard.check("write_file", { path: "/workspace/private.key", content: "" }, ctxWithCustom);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });
  });

  describe("read operations pass through", () => {
    it("allows read_file on .env", async () => {
      const result = await guard.check("read_file", { path: "/workspace/.env" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows read_file on secrets.json", async () => {
      const result = await guard.check("read_file", { path: "/workspace/secrets.json" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("unprotected write operations pass through", () => {
    it("allows write to normal source file", async () => {
      const result = await guard.check("write_file", { path: "/workspace/src/app.ts", content: "hello" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("non-write tools pass through", () => {
    it("allows list_directory regardless", async () => {
      const result = await guard.check("list_directory", { path: "/workspace" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2.3 GitSafetyGuard
// ---------------------------------------------------------------------------

describe("GitSafetyGuard", () => {
  describe("git_commit — protected branch policy", () => {
    it("rejects commit on main with permission error", async () => {
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "main\n";
        if (args[0] === "diff") return "file1.ts\nfile2.ts\n"; // 2 staged files
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_commit", { message: "fix: bug" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
      expect(result.error?.message).toMatch(/main/);
    });

    it("rejects commit on production with permission error", async () => {
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "production\n";
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_commit", { message: "deploy" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("allows commit on agent/foo branch", async () => {
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "agent/foo\n";
        if (args[0] === "diff") return "a.ts\n"; // 1 staged file
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_commit", { message: "feat: thing" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows commit on feature/bar branch", async () => {
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "feature/bar\n";
        if (args[0] === "diff") return "x.ts\n";
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_commit", { message: "feat: bar" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("git_commit — staged file count limit", () => {
    it("allows commit when staged file count is at the limit", async () => {
      const maxFiles = 5;
      const files = `${Array.from({ length: maxFiles }, (_, i) => `file${i}.ts`).join("\n")}\n`;
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "agent/test\n";
        if (args[0] === "diff") return files;
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFilesPerCommit: maxFiles });
      const result = await guard.check("git_commit", { message: "feat: update" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects commit when staged file count exceeds the limit", async () => {
      const maxFiles = 3;
      const files = `${Array.from({ length: maxFiles + 1 }, (_, i) => `file${i}.ts`).join("\n")}\n`;
      const guard = new GitSafetyGuard(async (args) => {
        if (args[0] === "rev-parse") return "agent/test\n";
        if (args[0] === "diff") return files;
        return "";
      });
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFilesPerCommit: maxFiles });
      const result = await guard.check("git_commit", { message: "feat: big" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("validation");
    });
  });

  describe("git_branch_create — naming convention", () => {
    it("allows branch name matching agent/ prefix pattern", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_branch_create", { name: "agent/my-feature" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects branch name without agent/ prefix", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_branch_create", { name: "no-prefix" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("validation");
    });

    it("rejects empty branch name", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_branch_create", { name: "" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("validation");
    });

    it("rejects branch name matching only \"agent/\" with no description", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_branch_create", { name: "agent/" }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("validation");
    });
  });

  describe("git_branch_switch", () => {
    it("allows switching to any branch (no policy enforcement)", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_branch_switch", { name: "main" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("other tools pass through", () => {
    it("allows git_status (not in guard scope)", async () => {
      const guard = new GitSafetyGuard(async () => "");
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const result = await guard.check("git_status", {}, ctx);
      expect(result.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2.4 ShellRestrictionGuard
// ---------------------------------------------------------------------------

describe("ShellRestrictionGuard", () => {
  describe("blocklist enforcement", () => {
    it("rejects command matching blocklist pattern and includes pattern in error message", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      // Default blocklist includes 'rm -rf /'
      const result = await guard.check("run_command", { command: "rm", args: ["-rf", "/"] }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
      expect(result.error?.message).toMatch(/rm -rf \//);
    });

    it("rejects shutdown command matching blocklist", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "shutdown", args: ["-h", "now"] }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.message).toMatch(/shutdown/);
    });

    it("allows command not matching any blocklist pattern", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "ls", args: ["-la"] }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows bun test command not matching blocklist", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "bun", args: ["test"] }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("custom blocklist", () => {
    it("rejects custom blocklist pattern match", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", shellBlocklist: ["curl", "wget"] });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "curl", args: ["http://evil.com"] }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.message).toMatch(/curl/);
    });
  });

  describe("allowlist enforcement", () => {
    it("allows command matching allowlist pattern when allowlist is set", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        shellAllowlist: ["^bun ", "^npm "],
      });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "bun", args: ["test"] }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects command not matching allowlist even if not in blocklist", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        shellAllowlist: ["^bun ", "^npm "],
      });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "curl", args: ["http://example.com"] }, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("permission");
    });

    it("allows all commands when allowlist is null (blocklist-only mode)", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", shellAllowlist: null });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_command", { command: "curl", args: ["http://example.com"] }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("run_test_suite and install_dependencies", () => {
    it("allows run_test_suite with bun framework", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("run_test_suite", { framework: "bun" }, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows install_dependencies with bun", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("install_dependencies", { packageManager: "bun" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });

  describe("non-shell tools pass through", () => {
    it("allows read_file (not in guard scope)", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new ShellRestrictionGuard(ctx.config);
      const result = await guard.check("read_file", { path: "/workspace/foo.ts" }, ctx);
      expect(result.allowed).toBe(true);
    });
  });
});
