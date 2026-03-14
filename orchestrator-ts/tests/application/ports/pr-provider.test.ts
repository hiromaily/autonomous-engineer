import type { IPullRequestProvider, PrError, PrErrorCategory, PrResult } from "@/application/ports/pr-provider";
import type { PullRequestParams, PullRequestResult } from "@/domain/git/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Helper: build a minimal stub that satisfies IPullRequestProvider
// ---------------------------------------------------------------------------

function makeProvider(result: PrResult): IPullRequestProvider {
  return {
    createOrUpdate: async (_params: PullRequestParams): Promise<PrResult> => result,
  };
}

const sampleParams: PullRequestParams = {
  specName: "git-integration",
  branchName: "agent/git-integration",
  targetBranch: "main",
  title: "feat: add git integration",
  body: "## Summary\n- Implemented GitController",
  isDraft: false,
  specArtifactPath: ".kiro/specs/git-integration",
  completedTasks: ["1.1", "1.2"],
};

// ---------------------------------------------------------------------------
// PrErrorCategory union type
// ---------------------------------------------------------------------------

describe("PrErrorCategory union type", () => {
  it("includes auth, conflict, network, api categories", () => {
    const categories: PrErrorCategory[] = ["auth", "conflict", "network", "api"];
    expect(categories).toHaveLength(4);
  });

  it("maps all 4 categories to PrError correctly", () => {
    const errors: PrError[] = [
      { category: "auth", message: "Unauthorized", statusCode: 401 },
      { category: "conflict", message: "Merge conflict" },
      { category: "network", message: "Connection refused" },
      { category: "api", message: "Internal server error", statusCode: 500 },
    ];
    expect(errors.map(e => e.category)).toEqual(["auth", "conflict", "network", "api"]);
  });
});

// ---------------------------------------------------------------------------
// PrError interface shape
// ---------------------------------------------------------------------------

describe("PrError shape", () => {
  it("requires category and message, statusCode is optional", () => {
    const withoutStatusCode: PrError = { category: "network", message: "timeout" };
    expect(withoutStatusCode.category).toBe("network");
    expect(withoutStatusCode.statusCode).toBeUndefined();

    const withStatusCode: PrError = { category: "auth", message: "Unauthorized", statusCode: 401 };
    expect(withStatusCode.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PrResult discriminated union
// ---------------------------------------------------------------------------

describe("PrResult discriminated union", () => {
  it("narrows to PullRequestResult on ok: true", () => {
    const value: PullRequestResult = {
      url: "https://github.com/owner/repo/pull/42",
      title: "feat: add git integration",
      targetBranch: "main",
      isDraft: false,
    };
    const result: PrResult = { ok: true, value };

    if (result.ok) {
      expect(result.value.url).toContain("pull/42");
      expect(result.value.isDraft).toBe(false);
    } else {
      throw new Error("Expected ok: true");
    }
  });

  it("narrows to PrError on ok: false", () => {
    const result: PrResult = {
      ok: false,
      error: { category: "auth", message: "Unauthorized", statusCode: 401 },
    };

    if (!result.ok) {
      expect(result.error.category).toBe("auth");
      expect(result.error.statusCode).toBe(401);
    } else {
      throw new Error("Expected ok: false");
    }
  });

  it("handles conflict category", () => {
    const result: PrResult = {
      ok: false,
      error: { category: "conflict", message: "Cannot merge: conflicts detected" },
    };

    if (!result.ok) {
      expect(result.error.category).toBe("conflict");
      expect(result.error.statusCode).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// IPullRequestProvider contract via stub
// ---------------------------------------------------------------------------

describe("IPullRequestProvider contract (stub implementation)", () => {
  it("createOrUpdate() returns PrResult on success", async () => {
    const successResult: PrResult = {
      ok: true,
      value: {
        url: "https://github.com/owner/repo/pull/1",
        title: "feat: add git integration",
        targetBranch: "main",
        isDraft: false,
      },
    };
    const provider = makeProvider(successResult);
    const result = await provider.createOrUpdate(sampleParams);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toContain("pull/1");
      expect(result.value.targetBranch).toBe("main");
    }
  });

  it("createOrUpdate() returns auth error on 401 (postcondition: error.category === 'auth')", async () => {
    const authErrorResult: PrResult = {
      ok: false,
      error: { category: "auth", message: "Unauthorized", statusCode: 401 },
    };
    const provider = makeProvider(authErrorResult);
    const result = await provider.createOrUpdate(sampleParams);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("auth");
      expect(result.error.statusCode).toBe(401);
    }
  });

  it("createOrUpdate() returns network error on connection failure", async () => {
    const networkErrorResult: PrResult = {
      ok: false,
      error: { category: "network", message: "ECONNREFUSED" },
    };
    const provider = makeProvider(networkErrorResult);
    const result = await provider.createOrUpdate(sampleParams);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network");
    }
  });

  it("createOrUpdate() accepts isDraft: true and propagates it in result", async () => {
    const draftResult: PrResult = {
      ok: true,
      value: {
        url: "https://github.com/owner/repo/pull/2",
        title: "feat: draft implementation",
        targetBranch: "main",
        isDraft: true,
      },
    };
    const provider = makeProvider(draftResult);
    const draftParams: PullRequestParams = { ...sampleParams, isDraft: true };
    const result = await provider.createOrUpdate(draftParams);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isDraft).toBe(true);
    }
  });

  it("createOrUpdate() returns api error on 500 response", async () => {
    const apiErrorResult: PrResult = {
      ok: false,
      error: { category: "api", message: "Internal server error", statusCode: 500 },
    };
    const provider = makeProvider(apiErrorResult);
    const result = await provider.createOrUpdate(sampleParams);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("api");
      expect(result.error.statusCode).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check for PrErrorCategory
// ---------------------------------------------------------------------------

const _exhaustiveCategory = (cat: PrErrorCategory): string => {
  switch (cat) {
    case "auth":
      return "auth";
    case "conflict":
      return "conflict";
    case "network":
      return "network";
    case "api":
      return "api";
  }
};
