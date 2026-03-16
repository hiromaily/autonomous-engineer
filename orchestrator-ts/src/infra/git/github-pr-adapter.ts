// ---------------------------------------------------------------------------
// GitHubPrAdapter — adapters/git/github-pr-adapter.ts
//
// Implements IPullRequestProvider using the GitHub REST API via native fetch.
// No third-party GitHub SDK. Token is never exposed in results or logs.
// ---------------------------------------------------------------------------

import type { IPullRequestProvider, PrResult } from "@/application/ports/pr-provider";
import type { PullRequestParams, PullRequestResult } from "@/domain/git/types";

export interface GitHubPrAdapterConfig {
  /** Default: "https://api.github.com" */
  readonly apiBaseUrl: string;
  readonly owner: string;
  readonly repo: string;
  /** Bearer token for Authorization header. Never exposed in logs/events/results. */
  readonly token: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface GitHubPrResponse {
  number: number;
  html_url: string;
  title: string;
  base: { ref: string };
  draft: boolean;
}

export class GitHubPrAdapter implements IPullRequestProvider {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly config: GitHubPrAdapterConfig,
    // Allow injection for testing; default to global fetch (Bun built-in)
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {
    this.headers = {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async createOrUpdate(params: PullRequestParams): Promise<PrResult> {
    const title = params.title.slice(0, 72);
    const { apiBaseUrl, owner, repo } = this.config;
    const headers = this.headers;

    try {
      // Step 1: Check for an existing open PR for this branch
      const encodedOwner = encodeURIComponent(owner);
      const encodedBranch = encodeURIComponent(params.branchName);
      const getUrl = `${apiBaseUrl}/repos/${owner}/${repo}/pulls?head=${encodedOwner}:${encodedBranch}&state=open`;

      const getResponse = await this.fetchFn(getUrl, { method: "GET", headers });

      if (!getResponse.ok) {
        return this.mapErrorResponse(getResponse);
      }

      const existingPrs = (await getResponse.json()) as GitHubPrResponse[];

      // Step 2a: Update existing PR via PATCH
      if (existingPrs.length > 0) {
        const existing = existingPrs[0];
        if (!existing) throw new Error("Unexpected: empty PR list after length check");
        const patchUrl = `${apiBaseUrl}/repos/${owner}/${repo}/pulls/${existing.number}`;

        const patchResponse = await this.fetchFn(patchUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title, body: params.body }),
        });

        if (!patchResponse.ok) {
          return this.mapErrorResponse(patchResponse);
        }

        const updated = (await patchResponse.json()) as GitHubPrResponse;
        return { ok: true, value: this.mapPrResponse(updated) };
      }

      // Step 2b: Create new PR via POST
      const postUrl = `${apiBaseUrl}/repos/${owner}/${repo}/pulls`;
      const postResponse = await this.fetchFn(postUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title,
          body: params.body,
          head: params.branchName,
          base: params.targetBranch,
          draft: params.isDraft,
        }),
      });

      if (!postResponse.ok) {
        return this.mapErrorResponse(postResponse);
      }

      const created = (await postResponse.json()) as GitHubPrResponse;
      return { ok: true, value: this.mapPrResponse(created) };
    } catch (err) {
      return {
        ok: false,
        error: {
          category: "network",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async mapErrorResponse(response: Response): Promise<PrResult> {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // ignore JSON parse errors — use default message
    }

    if (response.status === 401) {
      return {
        ok: false,
        error: { category: "auth", message, statusCode: 401 },
      };
    }

    return {
      ok: false,
      error: { category: "api", message, statusCode: response.status },
    };
  }

  private mapPrResponse(pr: GitHubPrResponse): PullRequestResult {
    return {
      url: pr.html_url,
      title: pr.title,
      targetBranch: pr.base.ref,
      isDraft: pr.draft,
    };
  }
}
