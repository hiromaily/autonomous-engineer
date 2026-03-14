import { describe, expect, it } from "bun:test";
import { GitHubPrAdapter } from "../../../adapters/git/github-pr-adapter";
import type { PullRequestParams } from "../../../domain/git/types";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DEFAULT_CONFIG = {
  apiBaseUrl: "https://api.github.com",
  owner: "test-owner",
  repo: "test-repo",
  token: "ghp_secret_token",
};

const DEFAULT_PARAMS: PullRequestParams = {
  specName: "git-integration",
  branchName: "agent/git-integration",
  targetBranch: "main",
  title: "feat: implement git integration",
  body: "## Summary\n\nImplemented git integration feature.",
  isDraft: false,
  specArtifactPath: ".kiro/specs/git-integration",
  completedTasks: ["Task 1", "Task 2"],
};

// ---------------------------------------------------------------------------
// Task 6 — GitHubPrAdapter
// ---------------------------------------------------------------------------

describe("GitHubPrAdapter", () => {
  describe("createOrUpdate — happy path: no existing PR → POST create", () => {
    it("calls GET to check for existing PRs and POST to create a new one", async () => {
      const calls: Array<{ url: string; method: string }> = [];

      const mockFetch: MockFetchFn = async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method });

        if (method === "GET") {
          // No existing PRs
          return makeJsonResponse(200, []);
        }
        if (method === "POST") {
          return makeJsonResponse(201, {
            html_url: "https://github.com/test-owner/test-repo/pull/42",
            title: "feat: implement git integration",
            base: { ref: "main" },
            draft: false,
            number: 42,
          });
        }
        return makeJsonResponse(500, { message: "unexpected" });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toBe("https://github.com/test-owner/test-repo/pull/42");
        expect(result.value.title).toBe("feat: implement git integration");
        expect(result.value.targetBranch).toBe("main");
        expect(result.value.isDraft).toBe(false);
      }

      // Should have called GET then POST
      expect(calls).toHaveLength(2);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[1]!.method).toBe("POST");
    });

    it("sends correct headers including Authorization", async () => {
      const capturedHeaders: HeadersInit[] = [];

      const mockFetch: MockFetchFn = async (url, init) => {
        if (init?.headers) capturedHeaders.push(init.headers);
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: "feat: test",
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(DEFAULT_PARAMS);

      // Check that at least one request had the Authorization header
      const allHeaderObjs = capturedHeaders.map((h) =>
        h instanceof Headers ? Object.fromEntries(h.entries()) : h,
      );
      const hasAuth = allHeaderObjs.some(
        (h) => (h as Record<string, string>)["Authorization"] === `Bearer ${DEFAULT_CONFIG.token}`,
      );
      expect(hasAuth).toBe(true);
    });

    it("includes correct POST body fields (title, body, head, base, draft)", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      const mockFetch: MockFetchFn = async (url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        if (init?.body) capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: DEFAULT_PARAMS.title,
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(capturedBody).toBeDefined();
      expect(capturedBody!["title"]).toBe(DEFAULT_PARAMS.title);
      expect(capturedBody!["body"]).toBe(DEFAULT_PARAMS.body);
      expect(capturedBody!["head"]).toBe(DEFAULT_PARAMS.branchName);
      expect(capturedBody!["base"]).toBe(DEFAULT_PARAMS.targetBranch);
      expect(capturedBody!["draft"]).toBe(false);
    });
  });

  describe("createOrUpdate — existing PR found → PATCH update", () => {
    it("uses PATCH instead of POST when an existing open PR is found", async () => {
      const calls: Array<{ url: string; method: string }> = [];

      const mockFetch: MockFetchFn = async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method });

        if (method === "GET") {
          return makeJsonResponse(200, [
            {
              number: 99,
              html_url: "https://github.com/test-owner/test-repo/pull/99",
              title: "old title",
              base: { ref: "main" },
              draft: false,
            },
          ]);
        }
        if (method === "PATCH") {
          return makeJsonResponse(200, {
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            title: DEFAULT_PARAMS.title,
            base: { ref: "main" },
            draft: false,
            number: 99,
          });
        }
        return makeJsonResponse(500, { message: "unexpected" });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(true);
      expect(calls.some((c) => c.method === "PATCH")).toBe(true);
      expect(calls.some((c) => c.method === "POST")).toBe(false);

      if (result.ok) {
        expect(result.value.url).toBe("https://github.com/test-owner/test-repo/pull/99");
      }
    });

    it("sends PATCH to the correct PR number URL", async () => {
      let patchUrl: string | undefined;

      const mockFetch: MockFetchFn = async (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return makeJsonResponse(200, [{ number: 77, html_url: "...", title: "old", base: { ref: "main" }, draft: false }]);
        }
        if (method === "PATCH") {
          patchUrl = String(url);
          return makeJsonResponse(200, {
            html_url: "https://github.com/test-owner/test-repo/pull/77",
            title: "updated",
            base: { ref: "main" },
            draft: false,
            number: 77,
          });
        }
        return makeJsonResponse(500, {});
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(patchUrl).toContain("/repos/test-owner/test-repo/pulls/77");
    });
  });

  describe("createOrUpdate — draft PR creation", () => {
    it("sets draft: true in POST payload when params.isDraft is true", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        if (init?.body) capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: "draft PR",
          base: { ref: "main" },
          draft: true,
          number: 1,
        });
      };

      const draftParams: PullRequestParams = { ...DEFAULT_PARAMS, isDraft: true };
      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(draftParams);

      expect(capturedBody!["draft"]).toBe(true);
      if (result.ok) {
        expect(result.value.isDraft).toBe(true);
      }
    });
  });

  describe("createOrUpdate — title capping", () => {
    it("caps title at 72 characters before submission", async () => {
      let capturedTitle: string | undefined;

      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        if (init?.body) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          capturedTitle = body["title"] as string;
        }
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: capturedTitle ?? "capped",
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const longTitle = "a".repeat(100);
      const longTitleParams: PullRequestParams = { ...DEFAULT_PARAMS, title: longTitle };
      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(longTitleParams);

      expect(capturedTitle).toBeDefined();
      expect(capturedTitle!.length).toBeLessThanOrEqual(72);
    });

    it("does not truncate titles at or below 72 characters", async () => {
      let capturedTitle: string | undefined;

      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        if (init?.body) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          capturedTitle = body["title"] as string;
        }
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: capturedTitle ?? "ok",
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const exactTitle = "a".repeat(72);
      const exactTitleParams: PullRequestParams = { ...DEFAULT_PARAMS, title: exactTitle };
      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(exactTitleParams);

      expect(capturedTitle).toHaveLength(72);
    });
  });

  describe("createOrUpdate — HTTP 401 auth failure", () => {
    it("maps HTTP 401 GET response to PrResult { ok: false, error: { category: 'auth', statusCode: 401 } }", async () => {
      const mockFetch: MockFetchFn = async () => {
        return makeJsonResponse(401, { message: "Bad credentials" });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("auth");
        expect(result.error.statusCode).toBe(401);
      }
    });

    it("maps HTTP 401 POST response to PrResult { ok: false, error: { category: 'auth', statusCode: 401 } }", async () => {
      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        return makeJsonResponse(401, { message: "Bad credentials" });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("auth");
        expect(result.error.statusCode).toBe(401);
      }
    });
  });

  describe("createOrUpdate — non-2xx errors", () => {
    it("maps HTTP 422 POST response to PrResult { ok: false, error: { category: 'api' } }", async () => {
      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        return makeJsonResponse(422, { message: "Validation Failed" });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("api");
        expect(result.error.statusCode).toBe(422);
      }
    });

    it("maps network failure to PrResult { ok: false, error: { category: 'network' } }", async () => {
      const mockFetch: MockFetchFn = async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("network");
      }
    });
  });

  describe("createOrUpdate — token security", () => {
    it("never exposes the token in the returned result on success", async () => {
      const mockFetch: MockFetchFn = async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") return makeJsonResponse(200, []);
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: "secure",
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ghp_secret_token");
    });

    it("never exposes the token in the returned result on failure", async () => {
      const mockFetch: MockFetchFn = async () => makeJsonResponse(401, { message: "Bad credentials" });

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      const result = await adapter.createOrUpdate(DEFAULT_PARAMS);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ghp_secret_token");
    });
  });

  describe("createOrUpdate — GET URL construction", () => {
    it("queries correct GET URL including head filter", async () => {
      let getUrl: string | undefined;

      const mockFetch: MockFetchFn = async (url, init) => {
        if ((init?.method ?? "GET") === "GET") {
          getUrl = String(url);
          return makeJsonResponse(200, []);
        }
        return makeJsonResponse(201, {
          html_url: "https://github.com/test-owner/test-repo/pull/1",
          title: "test",
          base: { ref: "main" },
          draft: false,
          number: 1,
        });
      };

      const adapter = new GitHubPrAdapter(DEFAULT_CONFIG, mockFetch);
      await adapter.createOrUpdate(DEFAULT_PARAMS);

      expect(getUrl).toContain("/repos/test-owner/test-repo/pulls");
      expect(getUrl).toContain("state=open");
      // Branch name may be URL-encoded (e.g. "/" → "%2F")
      expect(decodeURIComponent(getUrl!)).toContain(DEFAULT_PARAMS.branchName);
    });
  });
});
