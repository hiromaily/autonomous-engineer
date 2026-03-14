// ---------------------------------------------------------------------------
// IPullRequestProvider port — application/ports/pr-provider.ts
//
// Port contract for creating or updating pull/merge requests on a hosting provider.
// No implementation code — interface definitions only.
// ---------------------------------------------------------------------------

import type { PullRequestParams, PullRequestResult } from "@/domain/git/types";

/**
 * Category of pull request operation failure.
 * - "auth": HTTP 401; token missing or expired.
 * - "conflict": Branch cannot be merged due to conflicts.
 * - "network": Connection failure; DNS error; timeout.
 * - "api": Other non-2xx hosting-provider API error.
 */
export type PrErrorCategory = "auth" | "conflict" | "network" | "api";

/**
 * Structured error returned when createOrUpdate fails.
 */
export interface PrError {
  readonly category: PrErrorCategory;
  readonly message: string;
  /** HTTP status code, when the failure originated from an HTTP response. */
  readonly statusCode?: number;
}

/**
 * Discriminated union result type for pull request provider operations.
 * Postconditions:
 * - On success, value contains the PR URL.
 * - On HTTP 401, error.category === "auth".
 */
export type PrResult =
  | { readonly ok: true; readonly value: PullRequestResult }
  | { readonly ok: false; readonly error: PrError };

/**
 * Port contract for creating or updating pull/merge requests on a hosting provider.
 * Implemented by GitHubPrAdapter (and future GitLabPrAdapter) in the adapter layer.
 */
export interface IPullRequestProvider {
  /**
   * Create a new pull request, or update the existing one if the branch already has an open PR.
   * Postconditions: On success, returns the PR URL. On HTTP 401, error.category === "auth".
   */
  createOrUpdate(params: PullRequestParams): Promise<PrResult>;
}
